# 局域网 HTTPS API 网关模板

这是可选的部署附加模板，供已有 Immich 服务使用；提交这些文件不会部署或修改任何运行中的服务。服务器源码基线为 [Immich 官方 v3.4.1](https://github.com/immich-app/immich/releases/tag/v3.4.1)，保留上游历史和许可证。

Caddy 以普通用户运行，只在所选现有 LAN 接口的 TCP `8443` 提供 HTTPS，把 `/api`、`/api/*` 原样转发至 `127.0.0.1:2283`，其余路径返回 `404`。管理接口、HTTP 自动跳转、HTTP/3 和访问日志均未启用。此配置不提供 Web 页面，也不修改后端、容器、数据库、DNS、防火墙或路由器。选择可达范围符合要求的 LAN 接口；绑定接口本身不构成来源地址访问控制。

## 人工安装

需要已有的非特权 Linux 账号、可用的 systemd 用户服务，以及可从该主机访问的 `http://127.0.0.1:2283/api/server/ping`。开机后用户服务是否持续运行由主机既有策略决定，本模板不修改该策略。

1. 按 [Caddy 来源与校验](CADDY-PROVENANCE.md) 下载并核对 v2.11.9，解压取得 `caddy`。
2. 在本目录人工执行下面的文件安装。已有同名文件时先审阅并备份，避免覆盖已有部署。

```sh
install -d -m 0700 "$HOME/.local/lib/mjora-lan-gateway"
install -d -m 0700 "$HOME/.config/mjora-lan-gateway"
install -d -m 0700 "$HOME/.local/share/mjora-lan-gateway"
install -d -m 0700 "$HOME/.config/systemd/user"
install -m 0755 ./caddy "$HOME/.local/lib/mjora-lan-gateway/caddy"
install -m 0600 Caddyfile "$HOME/.config/mjora-lan-gateway/Caddyfile"
install -m 0600 gateway.env.example "$HOME/.config/mjora-lan-gateway/gateway.env"
install -m 0644 mjora-lan-gateway.service "$HOME/.config/systemd/user/mjora-lan-gateway.service"
```

3. 在主机本地编辑 `~/.config/mjora-lan-gateway/gateway.env`，把 `192.0.2.10` 替换为该主机已有的 LAN IPv4 地址。示例地址属于文档保留网段，不能直接用于部署。实际环境文件留在主机上。
4. 先验证配置，再由部署者启动：

```sh
umask 077
XDG_DATA_HOME="$HOME/.local/share/mjora-lan-gateway" \
XDG_CONFIG_HOME="$HOME/.config/mjora-lan-gateway" \
"$HOME/.local/lib/mjora-lan-gateway/caddy" validate \
  --config "$HOME/.config/mjora-lan-gateway/Caddyfile" \
  --adapter caddyfile \
  --envfile "$HOME/.config/mjora-lan-gateway/gateway.env"
systemctl --user daemon-reload
systemctl --user enable --now mjora-lan-gateway.service
systemctl --user status mjora-lan-gateway.service
```

## 验证与应用信任

检查监听，确认该 Caddy 进程只绑定配置中的 LAN 地址和 TCP `8443`；不应由它额外创建 `80`、`443`、`2019` 或 UDP 监听。运行日志可用 `journalctl --user -u mjora-lan-gateway.service` 查看，未启用请求访问日志。

首次验证或运行时，Caddy 在 `~/.local/share/mjora-lan-gateway/caddy/` 内生成独立 CA 和服务端证书。`UMask=0077` 用于用户服务生成的私有文件；手工验证也应先运行 `umask 077`。私钥始终留在主机私有数据目录，不进 Git、客户端包或公开下载。公开根证书通常位于 `pki/authorities/local/root.crt`；它是部署专属身份材料，也不随此公开模板发布。

从已认证的管理通道取得该公开根证书并核对 SHA256 指纹；不要从待验证的 HTTPS 入口取得并直接信任。以下检查在主机上执行：

```sh
set -a
. "$HOME/.config/mjora-lan-gateway/gateway.env"
set +a
MJORA_CA_PEM="$HOME/.local/share/mjora-lan-gateway/caddy/pki/authorities/local/root.crt"
openssl x509 -in "$MJORA_CA_PEM" -noout -fingerprint -sha256
curl --cacert "$MJORA_CA_PEM" --fail --silent --show-error \
  "https://${MJORA_LAN_IP}:8443/api/server/ping"
curl --cacert "$MJORA_CA_PEM" --silent --show-error --output /dev/null \
  --write-out '%{http_code}\n' "https://${MJORA_LAN_IP}:8443/"
curl --cacert "$MJORA_CA_PEM" --silent --show-error --output /dev/null \
  --write-out '%{http_code}\n' "https://${MJORA_LAN_IP}:8443/apix"
```

预期 ping 返回 HTTP `200` 且响应包含 `pong`，后两个请求返回 `404`。系统未信任该 CA 时，不带 `--cacert` 的请求应因证书信任失败而拒绝；不要用 `--insecure` 绕过验证。这些检查不需要账号或照片访问权限。

支持此机制的 mjora 客户端应把核对过的根证书仅绑定到指定账号与精确的 HTTPS API 根地址（协议、主机、端口、`/api` 路径），仍校验服务端身份和证书有效性，失败时拒绝该连接。单独配置客户端身份；此目录没有客户端身份文件、内置根证书或私有构建配置。无需向操作系统信任库安装 CA，也不要执行 `caddy trust`。

## 回退

```sh
systemctl --user disable --now mjora-lan-gateway.service
```

把客户端恢复为此前确认可用的 API 地址，并移除对应的应用内信任配置。确认不再使用后可人工移除本模板安装的 unit、二进制和配置，再运行 `systemctl --user daemon-reload`。独立 CA 数据先保留在私有位置以便恢复同一身份；这些操作不删除或迁移照片、数据库、后端服务。

## 上游更新

从 [Immich 官方仓库](https://github.com/immich-app/immich) 获取待审版本，在独立 staging 审阅提交、配置和数据库迁移，备份并验证恢复路径，构建并测试所需组件后，再人工安排生产升级。检查 `web`、`i18n`、SDK、CLI、机器学习等构建依赖，不能把非移动端目录一概当作可删除内容；本附加目录不提供源码裁剪包。保留上游历史、许可证和版本出处。这里没有自动更新或自动部署生产服务的任务。
