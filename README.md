# MCP Dock Data

MCP Dock 的数据镜像仓库，通过 GitHub Actions 定时从 [Smithery.ai](https://smithery.ai) 同步 MCP Server 数据。

## 数据结构

```
registry/
├── index.json          # 精简后的全量服务器列表
└── details/            # 各服务器的详细配置信息
    ├── smithery__hello-world.json
    └── ...
```

## 数据更新

数据每 6 小时自动同步一次，也可以通过 GitHub Actions 手动触发。

## CDN 访问

通过 jsDelivr CDN 访问数据：

- 列表: `https://cdn.jsdelivr.net/gh/{owner}/mcp-dock-data@main/registry/index.json`
- 详情: `https://cdn.jsdelivr.net/gh/{owner}/mcp-dock-data@main/registry/details/{name}.json`

## 数据来源

Data provided by [Smithery.ai](https://smithery.ai)

## License

MIT
