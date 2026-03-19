/**
 * McpDataProvider — reads card/landscape data live from the Turbo EA REST API.
 *
 * Uses the Turbo EA bulk export endpoint (GET /cards/export/json) to fetch
 * all cards in a single request, then normalizes them to the ArchLens
 * fact_sheet shape. Authentication uses a JWT stored in the workspace config.
 *
 * Analysis result tables (vendor_analysis, duplicate_clusters, etc.) remain
 * in SQLite — only the input card data is fetched live.
 */
const fetch = require('node-fetch');

class McpDataProvider {
  constructor(workspace, config) {
    this.workspace = workspace;
    this.baseUrl = config.turbo_ea_url;   // e.g. http://backend:8000/api/v1
    this.token = config.token;            // JWT access token
    this._cache = null;                   // in-memory cache for one analysis run
  }

  // ── API helper ─────────────────────────────────────────────────────────────
  async _fetch(path, params = {}) {
    const url = new URL(path, this.baseUrl);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await fetch(url.toString(), {
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Turbo EA API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  // ── Bulk fetch + cache ─────────────────────────────────────────────────────
  async _loadAll() {
    if (this._cache) return this._cache;

    const types = 'Application,ITComponent,Interface,Provider';
    const raw = await this._fetch('/api/v1/cards/export/json', {
      types,
      include_relations: true,
      include_stakeholders: true,
    });

    const all = (Array.isArray(raw) ? raw : []).map(card => this._normalize(card));

    this._cache = {
      apps:      all.filter(c => c.fs_type === 'Application'),
      itcs:      all.filter(c => c.fs_type === 'ITComponent'),
      ifaces:    all.filter(c => c.fs_type === 'Interface'),
      providers: all.filter(c => c.fs_type === 'Provider'),
      _raw:      all,
    };
    return this._cache;
  }

  // ── Turbo EA card → ArchLens fact_sheet shape ──────────────────────────────
  _normalize(card) {
    const attrs = card.attributes || {};
    const lc = this._extractLifecycle(card.lifecycle);
    const vendors = card.provider_names || [];
    const tags = (card.tags || []).map(t => t.name || t);
    const quality = card.data_quality || 0;
    const score = Math.round(quality);

    const issues = [];
    if (!card.owner) issues.push('no-owner');
    if (!card.description || card.description.trim().length < 5) issues.push('no-description');
    if (!lc) issues.push('no-lifecycle');
    else if (lc === 'endOfLife') issues.push('eol');
    else if (lc === 'phaseOut') issues.push('retiring');
    if (quality < 50) issues.push('incomplete');

    const ua = card.updated_at;
    if (ua) {
      const days = Math.floor((Date.now() - new Date(ua)) / 86400000);
      if (days > 180) issues.push('stale-' + days + 'd');
    }

    return {
      id:            card.id,
      fs_type:       card.type,
      name:          card.name || '(unnamed)',
      description:   card.description || '',
      lifecycle:     lc || 'Not set',
      owner:         card.owner || null,
      owner_email:   card.owner_email || null,
      completion:    quality / 100,
      updated_at:    ua || null,
      quality_score: score,
      locker:        score < 45 ? 'bronze' : score < 80 ? 'silver' : 'gold',
      issues:        JSON.stringify(issues),
      tags:          JSON.stringify(tags),
      vendors:       JSON.stringify(vendors),
      criticality:   attrs.businessCriticality || null,
      tech_fit:      attrs.technicalSuitability || attrs.technicalFit || null,
      fs_level:      null,
      annual_cost:   attrs.costTotalAnnual || 0,
    };
  }

  _extractLifecycle(lifecycle) {
    if (!lifecycle) return null;
    // Turbo EA stores lifecycle as array of {phase, startDate}
    // Find the currently active phase
    if (Array.isArray(lifecycle)) {
      const now = new Date().toISOString().slice(0, 10);
      const sorted = [...lifecycle].sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
      for (const entry of sorted) {
        if (entry.startDate && entry.startDate <= now) return entry.phase;
      }
      return sorted.length ? sorted[sorted.length - 1].phase : null;
    }
    if (typeof lifecycle === 'string') return lifecycle;
    return null;
  }

  // ── DataProvider interface ─────────────────────────────────────────────────

  async loadFullLandscape() {
    const data = await this._loadAll();
    const parse = raw => { try { return JSON.parse(raw || '[]'); } catch { return []; } };
    return {
      apps:      data.apps.map(r => ({ ...r, tags: parse(r.tags), vendors: parse(r.vendors) })),
      itcs:      data.itcs.map(r => ({ ...r, tags: parse(r.tags), vendors: parse(r.vendors) })),
      ifaces:    data.ifaces.map(r => ({ ...r, tags: parse(r.tags), vendors: parse(r.vendors || '[]') })),
      providers: data.providers.map(r => ({ ...r, tags: parse(r.tags) })),
      counts: {
        apps: data.apps.length,
        itcs: data.itcs.length,
        ifaces: data.ifaces.length,
        providers: data.providers.length,
      },
    };
  }

  async loadArchitectLandscape() {
    const data = await this._loadAll();
    // vendor_analysis is always local — read from SQLite
    const db = require('../db/db').getDB();
    const vendors = await db.all(
      `SELECT vendor_name, category, sub_category, app_count, total_cost, app_list
       FROM vendor_analysis WHERE workspace = ? ORDER BY app_count DESC`,
      [this.workspace]
    ).catch(() => []);

    // apps = all tech FS types (matching SQLite provider behavior)
    const techTypes = new Set(['Application', 'ITComponent', 'Interface', 'Middleware', 'Microservice', 'Service']);
    const apps = data._raw.filter(c => techTypes.has(c.fs_type));
    const appOnlyCount = apps.filter(a =>
      ['Application', 'Microservice', 'Service'].includes(a.fs_type)
    ).length;

    const byCategory = {};
    const parseJSON = raw => { try { return JSON.parse(raw || '[]'); } catch { return []; } };
    for (const v of vendors) {
      const cat = v.category || 'Other';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push({
        name: v.vendor_name,
        subCategory: v.sub_category,
        appCount: v.app_count,
        cost: v.total_cost,
        apps: parseJSON(v.app_list),
      });
    }

    return { vendors, apps, byCategory, vendorCount: vendors.length, appCount: appOnlyCount, totalTechFS: apps.length };
  }

  async getCardsWithVendors() {
    const data = await this._loadAll();
    const parse = raw => { try { return JSON.parse(raw || '[]'); } catch { return []; } };

    // Only cards with vendor relationships
    const cards = [...data.apps, ...data.itcs].filter(c => {
      const v = parse(c.vendors);
      return v.length > 0;
    });

    return {
      cards,
      providerCount: data.providers.length,
      providers: data.providers,
    };
  }

  async getOverviewStats() {
    const data = await this._loadAll();
    const all = data._raw;

    const byType = {};
    const lockers = { bronze: 0, silver: 0, gold: 0 };
    for (const r of all) {
      byType[r.fs_type] = (byType[r.fs_type] || 0) + 1;
      lockers[r.locker] = (lockers[r.locker] || 0) + 1;
    }

    const parse = raw => { try { return JSON.parse(raw || '[]'); } catch { return []; } };

    const eol = {};
    const noOwner = {};
    const costByType = {};
    for (const r of all) {
      const issues = parse(r.issues);
      if (issues.includes('eol')) eol[r.fs_type] = (eol[r.fs_type] || 0) + 1;
      if (!r.owner) noOwner[r.fs_type] = (noOwner[r.fs_type] || 0) + 1;
      if (r.annual_cost > 0) costByType[r.fs_type] = (costByType[r.fs_type] || 0) + r.annual_cost;
    }

    const topIssues = all
      .filter(r => r.locker === 'bronze' || r.locker === 'silver')
      .sort((a, b) => a.quality_score - b.quality_score)
      .slice(0, 15)
      .map(r => ({ ...r, issues: parse(r.issues) }));

    return {
      byType, lockers,
      lastSync: 'live',
      eol, noOwner, costByType, topIssues,
    };
  }

  async searchCards({ type = 'all', locker = 'bronze', search = '', page = 1, limit = 60 } = {}) {
    const data = await this._loadAll();
    let items = [...data._raw];

    if (type !== 'all') items = items.filter(r => r.fs_type === type);
    if (locker !== 'all') items = items.filter(r => r.locker === locker);
    if (search) {
      const q = search.toLowerCase();
      items = items.filter(r =>
        (r.name || '').toLowerCase().includes(q) ||
        (r.owner || '').toLowerCase().includes(q) ||
        (r.lifecycle || '').toLowerCase().includes(q) ||
        (r.description || '').toLowerCase().includes(q)
      );
    }

    items.sort((a, b) => (a.quality_score - b.quality_score) || (a.name || '').localeCompare(b.name || ''));
    const pg = parseInt(page);
    const lim = parseInt(limit);
    const offset = (pg - 1) * lim;

    const parse = raw => { try { return JSON.parse(raw || '[]'); } catch { return []; } };
    return {
      total: items.length,
      page: pg,
      items: items.slice(offset, offset + lim).map(r => ({
        ...r,
        issues: parse(r.issues),
        tags: parse(r.tags),
        vendors: parse(r.vendors),
      })),
    };
  }

  async getTypeStats() {
    const data = await this._loadAll();
    const parse = raw => { try { return JSON.parse(raw || '[]'); } catch { return []; } };
    const map = {};
    for (const r of data._raw) {
      if (!map[r.fs_type]) map[r.fs_type] = { fs_type: r.fs_type, total: 0, bronze: 0, silver: 0, gold: 0, total_cost: 0, no_owner: 0, eol_count: 0 };
      const m = map[r.fs_type];
      m.total++;
      m[r.locker] = (m[r.locker] || 0) + 1;
      m.total_cost += r.annual_cost || 0;
      if (!r.owner) m.no_owner++;
      if (parse(r.issues).includes('eol')) m.eol_count++;
    }
    return Object.values(map).sort((a, b) => b.total - a.total);
  }

  async exportCards({ locker, type } = {}) {
    const data = await this._loadAll();
    let items = [...data._raw];
    if (locker && locker !== 'all') items = items.filter(r => r.locker === locker);
    if (type   && type   !== 'all') items = items.filter(r => r.fs_type === type);
    items.sort((a, b) => a.quality_score - b.quality_score);
    return items;
  }

  async getDistinctVendorNames() {
    const data = await this._loadAll();
    const parse = raw => { try { return JSON.parse(raw || '[]'); } catch { return []; } };
    const names = new Set();
    for (const r of [...data.apps, ...data.itcs]) {
      for (const v of parse(r.vendors)) {
        if (v) names.add(v);
      }
    }
    return [...names].map(vendor_name => ({ vendor_name }));
  }
}

module.exports = { McpDataProvider };
