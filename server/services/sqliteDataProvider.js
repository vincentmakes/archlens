/**
 * SqliteDataProvider — reads card/landscape data from the local SQLite fact_sheets table.
 *
 * This is the original data path: sync from LeanIX or Turbo EA → SQLite → read here.
 * Implements the DataProvider interface so it can be swapped with McpDataProvider.
 */

class SqliteDataProvider {
  constructor(workspace) {
    this.workspace = workspace;
  }

  _db() {
    return require('../db/db').getDB();
  }

  _parseJSON(raw) {
    try { return JSON.parse(raw || '[]'); } catch { return []; }
  }

  // ── Full landscape: all 4 card types with full fields ──────────────────────
  // Used by: resolution.js (duplicates, vendor resolution, modernization)
  async loadFullLandscape() {
    const db = this._db();
    const ws = this.workspace;

    const [apps, itcs, ifaces, providers] = await Promise.all([
      db.all(
        `SELECT id,name,description,tags,vendors,lifecycle,criticality,tech_fit,annual_cost,quality_score,locker
         FROM fact_sheets WHERE workspace=? AND fs_type='Application'`, [ws]),
      db.all(
        `SELECT id,name,description,tags,vendors,lifecycle,tech_fit,annual_cost,quality_score,locker
         FROM fact_sheets WHERE workspace=? AND fs_type='ITComponent'`, [ws]),
      db.all(
        `SELECT id,name,description,tags,vendors,lifecycle
         FROM fact_sheets WHERE workspace=? AND fs_type='Interface'`, [ws]),
      db.all(
        `SELECT id,name,description,tags
         FROM fact_sheets WHERE workspace=? AND fs_type='Provider'`, [ws]),
    ]);

    const parse = this._parseJSON;
    return {
      apps:      apps.map(r => ({ ...r, tags: parse(r.tags), vendors: parse(r.vendors) })),
      itcs:      itcs.map(r => ({ ...r, tags: parse(r.tags), vendors: parse(r.vendors) })),
      ifaces:    ifaces.map(r => ({ ...r, tags: parse(r.tags), vendors: parse(r.vendors || '[]') })),
      providers: providers.map(r => ({ ...r, tags: parse(r.tags) })),
      counts: { apps: apps.length, itcs: itcs.length, ifaces: ifaces.length, providers: providers.length },
    };
  }

  // ── Architect landscape: vendor analysis + tech fact sheets ─────────────────
  // Used by: architect.js phases 1-3
  // NOTE: vendors[] comes from vendor_analysis (always local), apps from fact_sheets
  async loadArchitectLandscape() {
    const db = this._db();
    const ws = this.workspace;

    const vendors = await db.all(
      `SELECT vendor_name, category, sub_category, app_count, total_cost, app_list
       FROM vendor_analysis WHERE workspace = ? ORDER BY app_count DESC`,
      [ws]
    ).catch(() => []);

    const apps = await db.all(
      `SELECT name, fs_type, description, lifecycle, vendors, tags, criticality, tech_fit, annual_cost
       FROM fact_sheets
       WHERE workspace = ? AND fs_type IN ('Application','ITComponent','Interface','Middleware','Microservice','Service')
       ORDER BY fs_type, name`,
      [ws]
    ).catch(() => []);

    const appOnlyCount = apps.filter(a =>
      ['Application', 'Microservice', 'Service'].includes(a.fs_type)
    ).length;

    const byCategory = {};
    for (const v of vendors) {
      const cat = v.category || 'Other';
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push({
        name:        v.vendor_name,
        subCategory: v.sub_category,
        appCount:    v.app_count,
        cost:        v.total_cost,
        apps: this._parseJSON(v.app_list),
      });
    }

    return { vendors, apps, byCategory, vendorCount: vendors.length, appCount: appOnlyCount, totalTechFS: apps.length };
  }

  // ── Cards with vendor relationships (for vendor analysis input) ────────────
  // Used by: ai.js analyseVendors()
  async getCardsWithVendors() {
    const db = this._db();
    const ws = this.workspace;

    const cards = await db.all(
      `SELECT id, name, fs_type, vendors, annual_cost, description, tags
       FROM fact_sheets
       WHERE workspace = ?
         AND fs_type IN ('Application', 'ITComponent')
         AND vendors != '[]'
         AND vendors IS NOT NULL`,
      [ws]
    );

    const providerCount = await db.get(
      `SELECT COUNT(*) as c FROM fact_sheets WHERE workspace = ? AND fs_type = 'Provider'`,
      [ws]
    );

    const providers = await db.all(
      `SELECT name, annual_cost, description FROM fact_sheets WHERE workspace = ? AND fs_type = 'Provider'`,
      [ws]
    );

    return { cards, providerCount: providerCount?.c || 0, providers };
  }

  // ── Aggregated stats for overview dashboard ────────────────────────────────
  // Used by: index.js /api/data/overview
  async getOverviewStats() {
    const db = this._db();
    const ws = this.workspace;

    const [counts, issues, noOwner, topIssues, lastSyncRow, costByType] = await Promise.all([
      db.all(`SELECT fs_type, locker, COUNT(*) c FROM fact_sheets WHERE workspace=? GROUP BY fs_type, locker`, [ws]),
      db.all(`SELECT fs_type, COUNT(*) c FROM fact_sheets WHERE workspace=? AND issues LIKE '%"eol"%' GROUP BY fs_type`, [ws]),
      db.all(`SELECT fs_type, COUNT(*) c FROM fact_sheets WHERE workspace=? AND owner IS NULL GROUP BY fs_type`, [ws]),
      db.all(`SELECT id, fs_type, name, locker, quality_score, issues FROM fact_sheets WHERE workspace=? AND locker IN ('bronze','silver') ORDER BY quality_score ASC LIMIT 15`, [ws]),
      db.get(`SELECT last_sync FROM workspaces WHERE host=?`, [ws]),
      db.all(`SELECT fs_type, SUM(annual_cost) total FROM fact_sheets WHERE workspace=? AND annual_cost > 0 GROUP BY fs_type`, [ws]),
    ]);

    const byType = {};
    const lockers = { bronze: 0, silver: 0, gold: 0 };
    for (const r of counts) {
      byType[r.fs_type] = (byType[r.fs_type] || 0) + r.c;
      lockers[r.locker] = (lockers[r.locker] || 0) + r.c;
    }

    return {
      byType, lockers,
      lastSync:   lastSyncRow?.last_sync,
      eol:        Object.fromEntries(issues.map(r => [r.fs_type, r.c])),
      noOwner:    Object.fromEntries(noOwner.map(r => [r.fs_type, r.c])),
      costByType: Object.fromEntries(costByType.map(r => [r.fs_type, r.total])),
      topIssues:  topIssues.map(r => ({ ...r, issues: JSON.parse(r.issues || '[]') })),
    };
  }

  // ── Paginated card listing with filters ────────────────────────────────────
  // Used by: index.js /api/data/factsheets
  async searchCards({ type = 'all', locker = 'bronze', search = '', page = 1, limit = 60 } = {}) {
    const db = this._db();
    const where = ['workspace=?'];
    const params = [this.workspace];

    if (type !== 'all')   { where.push('fs_type=?'); params.push(type); }
    if (locker !== 'all') { where.push('locker=?');  params.push(locker); }
    if (search) {
      where.push('(name LIKE ? OR owner LIKE ? OR lifecycle LIKE ? OR description LIKE ?)');
      const q = `%${search}%`;
      params.push(q, q, q, q);
    }

    const wh = 'WHERE ' + where.join(' AND ');
    const pg = parseInt(page);
    const lim = parseInt(limit);

    const [cnt, rows] = await Promise.all([
      db.get(`SELECT COUNT(*) c FROM fact_sheets ${wh}`, params),
      db.all(
        `SELECT id, fs_type, name, description, lifecycle, owner, owner_email, completion,
                updated_at, quality_score, locker, issues, tags, vendors, criticality, tech_fit, fs_level, annual_cost
         FROM fact_sheets ${wh} ORDER BY quality_score ASC, name ASC
         LIMIT ? OFFSET ?`,
        [...params, lim, (pg - 1) * lim]
      ),
    ]);

    return {
      total: cnt.c,
      page: pg,
      items: rows.map(r => ({
        ...r,
        issues:  JSON.parse(r.issues  || '[]'),
        tags:    JSON.parse(r.tags    || '[]'),
        vendors: JSON.parse(r.vendors || '[]'),
      })),
    };
  }

  // ── Type breakdown stats ───────────────────────────────────────────────────
  // Used by: index.js /api/data/types
  async getTypeStats() {
    const db = this._db();
    const rows = await db.all(`
      SELECT fs_type,
        COUNT(*) total,
        SUM(CASE WHEN locker='bronze' THEN 1 ELSE 0 END) bronze,
        SUM(CASE WHEN locker='silver' THEN 1 ELSE 0 END) silver,
        SUM(CASE WHEN locker='gold'   THEN 1 ELSE 0 END) gold,
        SUM(annual_cost) total_cost,
        SUM(CASE WHEN owner IS NULL   THEN 1 ELSE 0 END) no_owner,
        SUM(CASE WHEN issues LIKE '%"eol"%' THEN 1 ELSE 0 END) eol_count
      FROM fact_sheets WHERE workspace=? GROUP BY fs_type ORDER BY total DESC`,
      [this.workspace]
    );
    return rows;
  }

  // ── CSV export ─────────────────────────────────────────────────────────────
  // Used by: index.js /api/data/export
  async exportCards({ locker, type } = {}) {
    const db = this._db();
    const where = ['workspace=?'];
    const params = [this.workspace];
    if (locker && locker !== 'all') { where.push('locker=?');  params.push(locker); }
    if (type   && type   !== 'all') { where.push('fs_type=?'); params.push(type); }

    return db.all(
      `SELECT name, fs_type, lifecycle, owner, owner_email, quality_score, locker,
              completion, annual_cost, updated_at, criticality, tech_fit, fs_level, issues, tags, vendors
       FROM fact_sheets WHERE ${where.join(' AND ')} ORDER BY quality_score ASC`,
      params
    );
  }

  // ── Distinct vendor names from JSON arrays ─────────────────────────────────
  // Used by: index.js /api/vendors/analyse/stream (pre-count)
  async getDistinctVendorNames() {
    const db = this._db();
    return db.all(
      `SELECT DISTINCT json_each.value AS vendor_name FROM fact_sheets, json_each(fact_sheets.vendors)
       WHERE workspace=? AND fs_type IN ('Application','ITComponent') AND vendors IS NOT NULL AND vendors != '[]'`,
      [this.workspace]
    ).catch(() => []);
  }
}

module.exports = { SqliteDataProvider };
