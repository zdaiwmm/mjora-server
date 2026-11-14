# mjora-server

mjora 的服务端开发仓库，由 [Immich](https://github.com/immich-app/immich) 派生。手机应用源码位于 [zdaiwmm/mjora](https://github.com/zdaiwmm/mjora)。

服务端源码基线为 **Immich v3.4.1**，提交 `22b95194c80a2f2e6201093916b6c8c3d6d271dd`。默认开发分支为 `mjora`，保留官方 Git 历史和原始 [AGPL-3.0 许可证](LICENSE)，便于审阅及合并后续功能。原项目介绍与贡献者信息保存在 [README.upstream.md](README.upstream.md)。

## 代码范围

- `server/`：API、任务处理和数据库相关源码。
- `machine-learning/`：机器学习服务。
- `web/`、`i18n/`、`packages/`、`.mise/`：服务端镜像所需的 Web 页面、翻译、SDK、CLI 和构建工具。
- `docker/`、`deployment/`：上游部署文件。
- [deploy/lan-gateway/](deploy/lan-gateway/README.md)：mjora 的可选局域网 HTTPS API 入口模板及证书信任说明。
- [deploy/web/](deploy/web/README.md)：在固定服务端版本上更新 Web 静态资源的候选镜像配方。

`mjora` 分支移除了手机端的 `mobile/`、`native/`、`fastlane/`，以及继承的自动构建发布任务。仓库保留服务端镜像需要的构建依赖。实际家庭配置、账号、照片、证书及私钥保存在部署环境中。

## 本地开发与构建

本地 `origin` 指向 `https://github.com/zdaiwmm/mjora-server.git`，`upstream` 指向官方仓库，并禁用向 `upstream` 推送。`mjora` 跟踪 `origin/mjora`；日常提交与推送进入自己的仓库。

本次创建的工作副本使用稀疏检出，已包含服务端镜像的构建输入。需要查看全部非手机端目录时，可执行 `git sparse-checkout disable`。

保留了上游的依赖锁文件和 Dockerfile。按上游要求准备 Docker 后，可在仓库根目录构建开发镜像：

```sh
docker build -f server/Dockerfile -t mjora-server:dev .
```

运行环境仍由部署者单独管理。本次仓库整理没有升级或重启正在运行的照片服务，也没有执行数据库迁移。网关模板验证通过不代表已经重新构建或验收整套服务端镜像。

## 合并官方更新

在临时更新分支审阅新版本，保留官方共同历史：

```sh
git fetch upstream --tags
git switch mjora
git switch -c update/immich-vX.Y.Z
git merge --no-ff --no-commit vX.Y.Z
```

把 `vX.Y.Z` 替换为已审阅的目标版本。处理冲突时保留自己的说明和网关模板，并检查上游构建依赖是否变化。上游新增的手机端文件或工作流可能直接合并成功，因此每次合并后、提交前，还要显式移除这些路径并确认检查结果为空：

```sh
git rm -r --sparse --ignore-unmatch mobile native fastlane .github/workflows CODEOWNERS
git ls-files mobile native fastlane .github/workflows CODEOWNERS
git diff --cached --name-status
```

随后验证依赖、镜像和测试，审阅数据库迁移及恢复方式，再提交并合并到 `mjora`。生产升级另行安排；本仓库没有自动部署生产环境的任务。

## 本次验证范围

API 服务端、机器学习和构建依赖源码沿用官方 v3.4.1。Web 增加断线重连后的照片列表补查，修复与验证范围见 [Web 验证记录](deploy/web/VALIDATION.md)。网关模板已用固定版本 Caddy 验证配置及路由，私有部署输入已排除。初始化没有执行完整的服务端镜像构建；手机端的后台及局域网上传验收记录见 [mjora 验证说明](https://github.com/zdaiwmm/mjora/blob/main/docs/validation/2026-11-14-background-runtime-validation.md)。
