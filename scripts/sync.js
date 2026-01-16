/**
 * MCP Dock Data Sync Script
 * 
 * ETL 脚本：从 Smithery.ai API 同步数据，清洗后存储为静态 JSON
 * 
 * 流程：
 * 1. Extract: 从 Smithery API 获取服务器列表和详情
 * 2. Transform: 清洗数据，剔除无关字段
 * 3. Load: 生成 JSON 文件
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_DIR = path.join(__dirname, '..', 'registry');
const DETAILS_DIR = path.join(REGISTRY_DIR, 'details');

const API_BASE = process.env.SMITHERY_API_BASE || 'https://api.smithery.ai';
const RATE_LIMIT_DELAY = 200; // ms between requests

/**
 * 延迟函数
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 安全的文件名转换
 * @param {string} qualifiedName - 如 "smithery/hello-world"
 * @returns {string} - 如 "smithery__hello-world"
 */
function toSafeFileName(qualifiedName) {
  return qualifiedName.replace(/\//g, '__');
}

/**
 * 获取服务器列表
 */
async function fetchServerList() {
  console.log('📥 Fetching server list...');
  
  const allServers = [];
  let page = 1;
  const pageSize = 100;
  
  while (true) {
    const url = `${API_BASE}/servers?page=${page}&pageSize=${pageSize}`;
    console.log(`  Fetching page ${page}...`);
    
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'MCP-Dock-Sync/1.0'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch server list: ${response.status}`);
    }
    
    const data = await response.json();
    const servers = data.servers || data;
    
    if (!Array.isArray(servers) || servers.length === 0) {
      break;
    }
    
    allServers.push(...servers);
    
    // 如果返回的数量小于 pageSize，说明已经是最后一页
    if (servers.length < pageSize) {
      break;
    }
    
    page++;
    await delay(RATE_LIMIT_DELAY);
  }
  
  console.log(`  ✅ Fetched ${allServers.length} servers`);
  return allServers;
}

/**
 * 获取单个服务器详情
 */
async function fetchServerDetail(qualifiedName) {
  const url = `${API_BASE}/servers/${encodeURIComponent(qualifiedName)}`;
  
  const response = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'MCP-Dock-Sync/1.0'
    }
  });
  
  if (!response.ok) {
    console.warn(`  ⚠️ Failed to fetch detail for ${qualifiedName}: ${response.status}`);
    return null;
  }
  
  return response.json();
}

/**
 * 转换列表项为精简格式
 */
function transformListItem(server) {
  return {
    id: server.qualifiedName || server.id,
    displayName: server.displayName || server.name,
    description: server.description || '',
    author: server.owner?.username || server.owner || 'unknown',
    iconUrl: server.iconUrl || server.icon || null,
    verified: server.verified || false,
    downloads: server.useCount || 0
  };
}

/**
 * 转换详情为精简格式
 * 剔除 isDeployed, remote, deploymentUrl, bundleUrl, security 等字段
 */
function transformDetail(detail) {
  // 获取第一个 stdio 类型的连接配置
  const connections = detail.connections || [];
  const stdioConnection = connections.find(c => c.type === 'stdio') || connections[0];
  
  // 构建清洗后的 connection 对象
  let connection = null;
  if (stdioConnection) {
    connection = {
      type: stdioConnection.type || 'stdio',
      runtime: stdioConnection.runtime || 'node',
      configSchema: stdioConnection.configSchema || {
        type: 'object',
        properties: {},
        required: []
      }
    };
    
    // 清理 configSchema 中可能存在的敏感默认值
    if (connection.configSchema.properties) {
      const cleanedProps = {};
      for (const [key, value] of Object.entries(connection.configSchema.properties)) {
        cleanedProps[key] = {
          type: value.type || 'string',
          description: value.description || '',
          ...(value.default !== undefined && { default: value.default }),
          ...(value.enum && { enum: value.enum })
        };
      }
      connection.configSchema.properties = cleanedProps;
    }
  }
  
  // 转换 tools 为 capabilities
  const capabilities = (detail.tools || []).map(tool => ({
    name: tool.name || tool.title || 'Unknown',
    description: tool.description || ''
  }));
  
  return {
    id: detail.qualifiedName || detail.id,
    displayName: detail.displayName || detail.name,
    description: detail.description || '',
    createdAt: detail.createdAt || new Date().toISOString(),
    links: {
      homepage: detail.homepage || detail.links?.homepage || '',
      registry: `https://smithery.ai/server/${detail.qualifiedName || detail.id}`
    },
    connection,
    capabilities
  };
}

/**
 * 主同步函数
 */
async function sync() {
  console.log('🚀 Starting MCP Dock data sync...\n');
  
  // 确保目录存在
  await fs.mkdir(DETAILS_DIR, { recursive: true });
  
  // 1. 获取服务器列表
  const serverList = await fetchServerList();
  
  // 2. 转换并保存列表索引
  const indexData = serverList.map(transformListItem);
  const indexPath = path.join(REGISTRY_DIR, 'index.json');
  await fs.writeFile(indexPath, JSON.stringify(indexData, null, 2));
  console.log(`\n📝 Saved index.json with ${indexData.length} entries`);
  
  // 3. 获取并保存每个服务器的详情
  console.log('\n📥 Fetching server details...');
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < serverList.length; i++) {
    const server = serverList[i];
    const qualifiedName = server.qualifiedName || server.id;
    
    if (!qualifiedName) {
      console.warn(`  ⚠️ Skipping server without qualifiedName at index ${i}`);
      failCount++;
      continue;
    }
    
    process.stdout.write(`  [${i + 1}/${serverList.length}] ${qualifiedName}...`);
    
    try {
      const detail = await fetchServerDetail(qualifiedName);
      
      if (detail) {
        const transformedDetail = transformDetail(detail);
        const safeFileName = toSafeFileName(qualifiedName);
        const detailPath = path.join(DETAILS_DIR, `${safeFileName}.json`);
        await fs.writeFile(detailPath, JSON.stringify(transformedDetail, null, 2));
        console.log(' ✅');
        successCount++;
      } else {
        console.log(' ❌');
        failCount++;
      }
    } catch (error) {
      console.log(` ❌ ${error.message}`);
      failCount++;
    }
    
    await delay(RATE_LIMIT_DELAY);
  }
  
  // 4. 输出统计
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
