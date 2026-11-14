# Web 静态资源更新

这个镜像配方把已构建的 Web 文件加入指定的 Immich 服务端镜像。基础镜像必须固定为当前部署版本：使用可验证的 registry digest，或从现有部署只读导出、校验 image ID 后赋予独立本地标签。构建参数不提供默认版本，避免意外升级 API 或数据库代码。

先按照仓库的 Web 开发要求构建 SDK、安装锁定依赖、运行检查与测试，再构建 Web：

```sh
pnpm --filter @immich/sdk build
pnpm --filter immich-web build
```

把 `web/build/` 的内容复制到独立构建目录的 `www/`，将本目录的 Dockerfile 放到该目录，并记录源码提交与资源校验值。只把该目录作为构建上下文：

```sh
docker build --platform linux/amd64 \
  --build-arg IMMICH_SERVER_IMAGE='ghcr.io/immich-app/immich-server@sha256:<当前镜像的完整摘要>' \
  --build-arg SOURCE_REVISION='<已验证的源码提交>' \
  -t mjora-server:web-candidate .
```

目标平台应与部署服务器一致。这个步骤只构建本地候选镜像，不执行部署。上线前保留原镜像和部署配置，单独批准切换照片服务；更新会重建该服务容器，可能短暂中断正在进行的请求。其他服务与照片存储沿用原配置。

验收失败时恢复原镜像并重建同一个照片服务容器。此更新没有数据库迁移；不要执行清理卷、数据库重置或删除照片的操作。
