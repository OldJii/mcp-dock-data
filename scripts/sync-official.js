/**
 * MCP Dock Data Sync Script - Official Registry
 * 
 * ETL 脚本：从 MCP 官方注册表 API 同步数据
 * 
 * 流程：
 * 1. Extract: 从 Official Registry API 获取服务器列表
 * 2. Transform: 转换数据格式
 * 3. Filter: 过滤掉无法安装的 MCP
 * 4. Enrich: 获取 GitHub star 数量
 * 5. Load: 生成 JSON 文件（按 star 数量排序）
 * 
 * 过滤规则：
 * - 必须有 packages（不支持只有 remotes 的 MCP，因为远程服务器可靠性低）
 * - packages 中只保留支持的 registryType: npm, pypi, oci
 * - 过滤掉不支持的 registryType: mcpb, nuget 等
 * 
 * 注意：README 不在此处获取，由客户端实时从 GitHub 获取
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_DIR = path.join(__dirname, '..', 'registry', 'official');
const DETAILS_DIR = path.join(REGISTRY_DIR, 'details');

const API_BASE = 'https://registry.modelcontextprotocol.io/v0.1';
const GITHUB_API_BASE = 'https://api.github.com';
const RATE_LIMIT_DELAY = 200; // ms between requests
const GITHUB_RATE_LIMIT_DELAY = 100; // ms between GitHub API requests

// GitHub Token (可选，用于提高 API 限制)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

// 支持的 registryType 列表
// npm: 通过 npx 安装
// pypi: 通过 uvx 安装
// oci: 通过 docker 安装
const SUPPORTED_REGISTRY_TYPES = ['npm', 'pypi', 'oci'];

/**
 * 延迟函数
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * GitHub star 缓存（避免重复请求同一仓库）
 */
const starCache = new Map();

/**
 * 从 GitHub URL 提取 owner 和 repo
 * @param {string} url - GitHub 仓库 URL
 * @returns {{ owner: string, repo: string } | null}
 */
function parseGitHubUrl(url) {
  if (!url) return null;
  
  // 支持多种 GitHub URL 格式
  const patterns = [
    /github\.com\/([^\/]+)\/([^\/\?#]+)/,
    /github\.com:([^\/]+)\/([^\/\?#]+)/,
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) {
      return {
        owner: match[1],
        repo: match[2].replace(/\.git$/, ''),
      };
    }
  }
  
  return null;
}

/**
 * 获取 GitHub 仓库的 star 数量
 * @param {string} repoUrl - GitHub 仓库 URL
 * @returns {Promise<number>} - star 数量，获取失败返回 0
 */
async function getGitHubStars(repoUrl) {
  const parsed = parseGitHubUrl(repoUrl);
  if (!parsed) return 0;
  
  const cacheKey = `${parsed.owner}/${parsed.repo}`;
  
  // 检查缓存
  if (starCache.has(cacheKey)) {
    return starCache.get(cacheKey);
  }
  
  try {
    const headers = {
      'Accept': 'application/vnd.github.v3+json',
      'User-Agent': 'MCP-Dock-Sync/1.0',
    };
    
    if (GITHUB_TOKEN) {
      headers['Authorization'] = `token ${GITHUB_TOKEN}`;
    }
    
    const response = await fetch(
      `${GITHUB_API_BASE}/repos/${parsed.owner}/${parsed.repo}`,
      { headers }
    );
    
    if (!response.ok) {
      // 仓库不存在或私有
      starCache.set(cacheKey, 0);
      return 0;
    }
    
    const data = await response.json();
    const stars = data.stargazers_count || 0;
    
    starCache.set(cacheKey, stars);
    return stars;
  } catch (error) {
    starCache.set(cacheKey, 0);
    return 0;
  }
}

/**
 * 安全的文件名转换
 * @param {string} name - 如 "io.github.user/weather"
 * @returns {string} - 如 "io.github.user__weather"
 */
function toSafeFileName(name) {
  return name.replace(/\//g, '__');
}

/**
 * 获取服务器列表
 */
async function fetchServerList() {
  console.log('📥 Fetching server list from Official Registry...');
  
  const allServers = [];
  let cursor = null;
  let pageCount = 0;
  
  while (true) {
    const url = cursor 
      ? `${API_BASE}/servers?cursor=${encodeURIComponent(cursor)}`
      : `${API_BASE}/servers`;
    
    pageCount++;
    console.log(`  Fetching page ${pageCount}...`);
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json, application/problem+json',
        'User-Agent': 'MCP-Dock-Sync/1.0'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch server list: ${response.status}`);
    }
    
    const data = await response.json();
    const servers = data.servers || [];
    
    if (servers.length === 0) {
      break;
    }
    
    allServers.push(...servers);
    
    // 检查是否有下一页
    cursor = data.metadata?.nextCursor;
    if (!cursor) {
      break;
    }
    
    await delay(RATE_LIMIT_DELAY);
  }
  
  console.log(`  ✅ Fetched ${allServers.length} servers`);
  return allServers;
}

/**
 * 获取图标 URL (优先 light 主题)
 */
function getIconUrl(icons) {
  if (!icons || !Array.isArray(icons) || icons.length === 0) {
    return null;
  }
  
  // 优先选择 light 主题的图标
  const lightIcon = icons.find(icon => icon.theme === 'light');
  if (lightIcon?.src) return lightIcon.src;
  
  // 其次选择没有主题的图标
  const defaultIcon = icons.find(icon => !icon.theme);
  if (defaultIcon?.src) return defaultIcon.src;
  
  // 最后返回第一个有 src 的图标
  const firstIcon = icons.find(icon => icon.src);
  return firstIcon?.src || null;
}

/**
 * 转换列表项为精简格式
 * 注意：stars 字段在主函数中单独添加
 */
function transformListItem(item) {
  const server = item.server || {};
  const meta = item._meta?.['io.modelcontextprotocol.registry/official'] || {};
  
  return {
    id: server.name || '',
    displayName: server.title || server.name || '',
    description: server.description || '',
    iconUrl: getIconUrl(server.icons),
    version: server.version || '',
    status: meta.status || 'active',
    publishedAt: meta.publishedAt || '',
    repository: server.repository ? {
      url: server.repository.url || '',
      source: server.repository.source || 'github',
      subfolder: server.repository.subfolder || undefined
    } : null,
    // stars 字段在主函数中添加
  };
}

/**
 * 转换单个 package 为标准格式
 */
function transformPackage(pkg) {
  return {
    registryType: pkg.registryType || 'npm',
    identifier: pkg.identifier || '',
    version: pkg.version || undefined,
    runtimeHint: pkg.runtimeHint || undefined,
    transport: pkg.transport ? {
      type: pkg.transport.type || 'stdio'
    } : { type: 'stdio' },
    environmentVariables: (pkg.environmentVariables || []).map(env => ({
      name: env.name || '',
      description: env.description || undefined,
      isRequired: env.isRequired || false,
      isSecret: env.isSecret || false,
      default: env.default || undefined,
      choices: env.choices || undefined
    })).filter(env => env.name),
    packageArguments: (pkg.packageArguments || []).map(arg => ({
      name: arg.name || '',
      description: arg.description || undefined,
      type: arg.type || 'positional',
      isRequired: arg.isRequired || false,
      default: arg.default || undefined
    })).filter(arg => arg.name),
    // 运行时参数（用于 Docker 等需要额外参数的情况）
    runtimeArguments: (pkg.runtimeArguments || []).map(arg => ({
      name: arg.name || '',
      description: arg.description || undefined,
      type: arg.type || 'named',
      isRequired: arg.isRequired || false,
      default: arg.default || undefined,
      valueHint: arg.valueHint || undefined
    })).filter(arg => arg.name)
  };
}

/**
 * 转换详情为完整格式
 * 注意：不包含 README，由客户端实时获取
 */
function transformDetail(item) {
  const server = item.server || {};
  const meta = item._meta?.['io.modelcontextprotocol.registry/official'] || {};
  
  // 转换 packages，只保留支持的 registryType
  const packages = (server.packages || [])
    .filter(pkg => SUPPORTED_REGISTRY_TYPES.includes(pkg.registryType))
    .map(transformPackage);
  
  // 转换 remotes（远程服务器，不需要本地安装）
  const remotes = (server.remotes || []).map(remote => ({
    type: remote.type || 'streamable-http',
    url: remote.url || '',
    headers: (remote.headers || []).map(header => ({
      name: header.name || '',
      description: header.description || undefined,
      isRequired: header.isRequired || false,
      isSecret: header.isSecret || false,
      default: header.default || undefined
    })).filter(h => h.name)
  })).filter(r => r.url);
  
  return {
    id: server.name || '',
    displayName: server.title || server.name || '',
    description: server.description || '',
    version: server.version || '',
    status: meta.status || 'active',
    publishedAt: meta.publishedAt || '',
    updatedAt: meta.updatedAt || '',
    iconUrl: getIconUrl(server.icons),
    websiteUrl: server.websiteUrl || null,
    repository: server.repository ? {
      url: server.repository.url || '',
      source: server.repository.source || 'github',
      subfolder: server.repository.subfolder || undefined
    } : null,
    // README 由客户端实时获取，这里只存储仓库信息
    packages: packages,
    // 远程服务器配置
    remotes: remotes
  };
}

/**
 * 去重：只保留每个服务器的最新版本
 * 根据 isLatest 标志或 publishedAt 时间判断
 */
function deduplicateServers(servers) {
  const serverMap = new Map();
  
  for (const item of servers) {
    const server = item.server || {};
    const meta = item._meta?.['io.modelcontextprotocol.registry/official'] || {};
    const name = server.name;
    
    if (!name) continue;
    
    const existing = serverMap.get(name);
    
    if (!existing) {
      serverMap.set(name, item);
      continue;
    }
    
    // 如果当前项标记为 isLatest，使用它
    if (meta.isLatest) {
      serverMap.set(name, item);
      continue;
    }
    
    // 比较发布时间，保留较新的
    const existingMeta = existing._meta?.['io.modelcontextprotocol.registry/official'] || {};
    const existingDate = new Date(existingMeta.publishedAt || 0);
    const currentDate = new Date(meta.publishedAt || 0);
    
    if (currentDate > existingDate) {
      serverMap.set(name, item);
    }
  }
  
  return Array.from(serverMap.values());
}

/**
 * 检查服务器是否有可用的安装方式
 * 注意：只检查 packages，不支持 remotes（远程服务器可靠性低）
 * @param {Object} item - 原始服务器数据
 * @returns {boolean} - 是否可安装
 */
function hasInstallableMethod(item) {
  const server = item.server || {};
  
  // 只检查是否有支持的 packages
  // 不支持 remotes，因为远程服务器可靠性低，很多已下线或返回错误
  const packages = server.packages || [];
  const supportedPackages = packages.filter(pkg => 
    SUPPORTED_REGISTRY_TYPES.includes(pkg.registryType)
  );
  
  return supportedPackages.length > 0;
}

/**
 * 过滤服务器列表，只保留可安装的
 * @param {Array} servers - 服务器列表
 * @returns {Object} - { filtered: 过滤后的列表, stats: 统计信息 }
 */
function filterInstallableServers(servers) {
  const stats = {
    total: servers.length,
    installable: 0,
    filtered: {
      noPackages: 0,
      onlyRemotes: 0,
      unsupportedRegistryType: 0,
    },
    registryTypes: {},
  };
  
  const filtered = servers.filter(item => {
    const server = item.server || {};
    const packages = server.packages || [];
    const remotes = server.remotes || [];
    
    // 统计 registryType
    packages.forEach(pkg => {
      const type = pkg.registryType || 'unknown';
      stats.registryTypes[type] = (stats.registryTypes[type] || 0) + 1;
    });
    
    // 检查是否可安装（只看 packages）
    if (hasInstallableMethod(item)) {
      stats.installable++;
      return true;
    }
    
    // 统计过滤原因
    if (packages.length === 0) {
      if (remotes.length > 0) {
        // 只有 remotes，没有 packages
        stats.filtered.onlyRemotes++;
      } else {
        // 既没有 packages 也没有 remotes
        stats.filtered.noPackages++;
      }
    } else {
      // 有 packages 但都是不支持的类型
      stats.filtered.unsupportedRegistryType++;
    }
    
    return false;
  });
  
  return { filtered, stats };
}

/**
 * 清理旧的详情文件
 */
async function cleanOldDetails() {
  try {
    const files = await fs.readdir(DETAILS_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        await fs.unlink(path.join(DETAILS_DIR, file));
      }
    }
    console.log(`  🧹 Cleaned ${files.length} old detail files`);
  } catch (error) {
    // 目录可能不存在，忽略错误
  }
}

/**
 * 主同步函数
 */
async function sync() {
  console.log('🚀 Starting MCP Dock Official Registry sync...\n');
  
  // 确保目录存在
  await fs.mkdir(DETAILS_DIR, { recursive: true });
  
  // 清理旧文件
  await cleanOldDetails();
  
  // 1. 获取服务器列表
  const rawServerList = await fetchServerList();
  
  // 2. 去重：只保留每个服务器的最新版本
  const deduplicatedList = deduplicateServers(rawServerList);
  console.log(`  📦 After deduplication: ${deduplicatedList.length} unique servers (from ${rawServerList.length} total)`);
  
  // 3. 过滤：只保留可安装的服务器
  const { filtered: serverList, stats } = filterInstallableServers(deduplicatedList);
  
  console.log(`\n📊 Filter Statistics:`);
  console.log(`   Total servers: ${stats.total}`);
  console.log(`   Installable: ${stats.installable}`);
  console.log(`   Filtered out:`);
  console.log(`     - No packages: ${stats.filtered.noPackages}`);
  console.log(`     - Only remotes (not supported): ${stats.filtered.onlyRemotes}`);
  console.log(`     - Unsupported registry type: ${stats.filtered.unsupportedRegistryType}`);
  console.log(`   Registry types found:`);
  Object.entries(stats.registryTypes).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
    const supported = SUPPORTED_REGISTRY_TYPES.includes(type) ? '✅' : '❌';
    console.log(`     - ${type}: ${count} ${supported}`);
  });
  
  // 4. 获取 GitHub star 数量
  console.log('\n⭐ Fetching GitHub stars...');
  const serverStars = new Map();
  let starFetchCount = 0;
  
  for (const item of serverList) {
    const server = item.server || {};
    const repoUrl = server.repository?.url;
    
    if (repoUrl && repoUrl.includes('github.com')) {
      const stars = await getGitHubStars(repoUrl);
      serverStars.set(server.name, stars);
      starFetchCount++;
      
      // 每 50 个输出一次进度
      if (starFetchCount % 50 === 0) {
        console.log(`   Fetched ${starFetchCount} repos...`);
      }
      
      await delay(GITHUB_RATE_LIMIT_DELAY);
    } else {
      serverStars.set(server.name, 0);
    }
  }
  console.log(`   ✅ Fetched stars for ${starFetchCount} GitHub repos`);
  
  // 5. 按 star 数量排序
  const sortedServerList = [...serverList].sort((a, b) => {
    const starsA = serverStars.get(a.server?.name) || 0;
    const starsB = serverStars.get(b.server?.name) || 0;
    return starsB - starsA; // 降序
  });
  
  // 6. 转换并保存列表索引（包含 stars 字段）
  const indexData = sortedServerList.map(item => {
    const listItem = transformListItem(item);
    listItem.stars = serverStars.get(item.server?.name) || 0;
    return listItem;
  });
  const indexPath = path.join(REGISTRY_DIR, 'index.json');
  await fs.writeFile(indexPath, JSON.stringify(indexData, null, 2));
  console.log(`\n📝 Saved index.json with ${indexData.length} entries (sorted by stars)`);
  
  // 输出 top 10 stars
  console.log('\n🏆 Top 10 by GitHub stars:');
  indexData.slice(0, 10).forEach((item, i) => {
    console.log(`   ${i + 1}. ${item.displayName} - ⭐ ${item.stars}`);
  });
  
  // 7. 保存每个服务器的详情
  console.log('\n📥 Saving server details...');
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < sortedServerList.length; i++) {
    const item = sortedServerList[i];
    const server = item.server || {};
    const name = server.name;
    
    if (!name) {
      console.warn(`  ⚠️ Skipping server without name at index ${i}`);
      failCount++;
      continue;
    }
    
    process.stdout.write(`  [${i + 1}/${sortedServerList.length}] ${name}...`);
    
    try {
      // 转换并保存详情（包含 stars 字段）
      const detail = transformDetail(item);
      detail.stars = serverStars.get(name) || 0;
      
      const safeFileName = toSafeFileName(name);
      const detailPath = path.join(DETAILS_DIR, `${safeFileName}.json`);
      await fs.writeFile(detailPath, JSON.stringify(detail, null, 2));
      
      console.log(' ✅');
      successCount++;
    } catch (error) {
      console.log(` ❌ ${error.message}`);
      failCount++;
    }
  }
  
  // 8. 输出统计
  console.log('\n📊 Sync completed!');
  console.log(`   ✅ Success: ${successCount}`);
  console.log(`   ❌ Failed: ${failCount}`);
  console.log(`   📁 Total files: ${successCount + 1} (index + details)`);
  console.log(`\n💡 Supported registry types: ${SUPPORTED_REGISTRY_TYPES.join(', ')}`);
  console.log(`💡 Servers are sorted by GitHub stars (descending)`);
}

// 运行同步
sync().catch(error => {
  console.error('❌ Sync failed:', error);
  process.exit(1);
});
