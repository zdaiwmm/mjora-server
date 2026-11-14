# Caddy 来源与校验

固定版本：**Caddy v2.11.9**。只使用官方发布的对应操作系统、架构二进制，不把二进制放进本仓库。

- [官方发布页](https://github.com/caddyserver/caddy/releases/tag/v2.11.9)
- [官方 SHA512 校验表](https://github.com/caddyserver/caddy/releases/download/v2.11.9/caddy_2.11.9_checksums.txt)
- [Linux amd64 压缩包](https://github.com/caddyserver/caddy/releases/download/v2.11.9/caddy_2.11.9_linux_amd64.tar.gz)
- [Linux arm64 压缩包](https://github.com/caddyserver/caddy/releases/download/v2.11.9/caddy_2.11.9_linux_arm64.tar.gz)

下列 SHA512 摘自该版本官方校验表；部署时重新取得官方校验表并逐字核对所选平台，再解压安装：

```text
0e85544340290a16ce4bfb76fe7d65e9de1bf3a6e67f5ccfff30b30d27ea4c73e078077b7bf3e58ae60b6b12e44327705287059c775bca5782e8ee85ea7edd75  caddy_2.11.9_linux_amd64.tar.gz
9e5e76d7888542924de2c25353ae87c5f77e2a22c5b1198633cae13688922282e05383d142599205c88d8d80eee5e967d291214d7abce4835329a191b20dd6e0  caddy_2.11.9_linux_arm64.tar.gz
```

例如在 Linux 上对下载的文件执行 `sha512sum caddy_2.11.9_linux_amd64.tar.gz`。升级 Caddy 时同时审阅官方变更、更新固定版本与校验值，在隔离环境验证后再人工安排上线。
