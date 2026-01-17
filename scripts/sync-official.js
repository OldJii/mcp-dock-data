/**
 * MCP Dock Data Sync Script - Official Registry
 * 
 * ETL 脚本：从 MCP 官方注册表 API 同步数据
 * 
 * 流程：
 * 1. Extract: 从 Official Registry API 获取服务器列表
 * 2. Transform: 转换数据格式
 * 3. Load: 生成 JSON 文件
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
const RATE_LIMIT_DELAY = 200; // ms between requests

/**
 * 延迟函数
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
    } : null
  };
}

/**
 * 转换详情为完整格式
 * 注意：不包含 README，由客户端实时获取
 */
function transformDetail(item) {
  const server = item.server || {};
  const meta = item._meta?.['io.modelcontextprotocol.registry/official'] || {};
  
  // 转换 packages
  const packages = (server.packages || []).map(pkg => ({
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
    })).filter(arg => arg.name)
  }));
  
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
    packages: packages
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
 * 主同步函数
 */
async function sync() {
  console.log('🚀 Starting MCP Dock Official Registry sync...\n');
  
  // 确保目录存在
  await fs.mkdir(DETAILS_DIR, { recursive: true });
  
  // 1. 获取服务器列表
  const rawServerList = await fetchServerList();
  
  // 2. 去重：只保留每个服务器的最新版本
  const serverList = deduplicateServers(rawServerList);
  console.log(`  📦 After deduplication: ${serverList.length} unique servers (from ${rawServerList.length} total)`);
  
  // 3. 转换并保存列表索引
  const indexData = serverList.map(transformListItem);
  const indexPath = path.join(REGISTRY_DIR, 'index.json');
  await fs.writeFile(indexPath, JSON.stringify(indexData, null, 2));
  console.log(`\n📝 Saved index.json with ${indexData.length} entries`);
  
  // 4. 保存每个服务器的详情
  console.log('\n📥 Saving server details...');
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < serverList.length; i++) {
    const item = serverList[i];
    const server = item.server || {};
    const name = server.name;
    
    if (!name) {
      console.warn(`  ⚠️ Skipping server without name at index ${i}`);
      failCount++;
      continue;
    }
    
    process.stdout.write(`  [${i + 1}/${serverList.length}] ${name}...`);
    
    try {
      // 转换并保存详情
      const detail = transformDetail(item);
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
  
  // 5. 输出统计
  console.log('\n📊 Sync completed!');
  console.log(`   ✅ Success: ${successCount}`);
  console.log(`   ❌ Failed: ${failCount}`);
  console.log(`   📁 Total files: ${successCount + 1} (index + details)`);
}

// 运行同步
sync().catch(error => {
  console.error('❌ Sync failed:', error);
  process.exit(1);
});
