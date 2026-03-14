/**
 * DataProvider factory — returns the appropriate data provider for a workspace.
 *
 * Two implementations:
 *   - SqliteDataProvider: reads from local fact_sheets table (sync-based)
 *   - McpDataProvider: reads live from Turbo EA API (for MCP-enabled sources)
 *
 * Analysis result tables (vendor_analysis, duplicate_clusters, etc.) always
 * stay in SQLite regardless of the data provider.
 */

const { SqliteDataProvider } = require('./sqliteDataProvider');
const { McpDataProvider } = require('./mcpDataProvider');

// In-memory cache of workspace configs to avoid repeated DB lookups.
// Cleared when a workspace is re-connected.
const _wsConfigCache = new Map();

/**
 * Create a DataProvider for the given workspace.
 *
 * For 'mcp' workspaces, returns McpDataProvider that fetches live from Turbo EA.
 * For all others (leanix, turboea sync), returns SqliteDataProvider.
 *
 * @param {string} workspace - workspace host key
 * @returns {SqliteDataProvider|McpDataProvider}
 */
function createDataProvider(workspace) {
  // Check cache first
  const cached = _wsConfigCache.get(workspace);
  if (cached && cached.source_type === 'mcp') {
    return new McpDataProvider(workspace, {
      turbo_ea_url: cached.turbo_ea_url,
      token: cached.token,
    });
  }

  // Default: SQLite provider (sync-based)
  return new SqliteDataProvider(workspace);
}

/**
 * Register an MCP workspace config so createDataProvider can return McpDataProvider.
 * Called when a workspace is connected with source_type='mcp'.
 */
function registerMcpWorkspace(workspace, config) {
  _wsConfigCache.set(workspace, {
    source_type: 'mcp',
    turbo_ea_url: config.turbo_ea_url,
    token: config.token,
  });
}

/**
 * Clear cached config for a workspace (e.g. on disconnect or re-connect).
 */
function clearWorkspaceCache(workspace) {
  _wsConfigCache.delete(workspace);
}

module.exports = { createDataProvider, registerMcpWorkspace, clearWorkspaceCache, SqliteDataProvider, McpDataProvider };
