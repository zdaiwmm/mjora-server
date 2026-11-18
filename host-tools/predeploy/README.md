# 发布前配置备份

候选提交通过仓库回归后、生产容器仍运行旧镜像时，在有权限读取实际配置的 Ubuntu 部署主机上执行本检查。原样保存 Compose 文件、环境配置及额外配置，并核对副本。数据库备份及校验仍按现有发布/恢复流程执行。

1. 从发布记录取得预期旧镜像的**完整本地镜像 ID**（`sha256:…`）和候选提交的完整 Git SHA；不要在切换后重新计算基线。核对待切换的容器名称。清点 Compose 实际使用的 `.env`、`--env-file`、各服务 `env_file`，以及 `include`/`extends` 引用、bind mount 的配置、外部 secrets/configs 的文件来源等。容器标签只自动提供当前叠加的 `-f` 文件，其他配置必须明确传入。参数需要在两次命令中一致。
2. 准备一个受保护、持久化、仅 root 可读写（`0700`）的备份父目录。将脚本从已审阅的发布提交放到主机可读的位置，然后执行 `capture`：

   ```bash
   snapshot_args=(
     --container "$BASELINE_CONTAINER"
     --expected-image "$BASELINE_IMAGE_ID"
     --candidate-sha "$CANDIDATE_SHA"
     --env-file /opt/immich/.env
     --snapshot "/var/lib/mjora/config-backups/$RELEASE_ATTEMPT"
   )
   # 为其余实际生效的环境/配置文件追加 --env-file /绝对路径 或 --config-file /绝对路径。
   sudo python3 /path/to/config_snapshot.py capture "${snapshot_args[@]}"
   ```

3. 切换服务前，在同一发布锁下、紧靠切换操作执行：

   ```bash
   sudo python3 /path/to/config_snapshot.py check "${snapshot_args[@]}"
   ```

   只有 `capture`、`check` 都成功，且其他发布门槛通过，才继续切换。在自动化编排中，将 `check` 的退出码作为切换前置条件。配置文件缺失、不可读、内容变化，或者基线容器已更换都会阻止通过。失败后查明原因，用新尝试目录重新采集，不覆盖旧目录。

目录和备份文件（含 `manifest.json`）分别为 `0700`、`0600`。命令成功时只汇报文件数量和提交 SHA。发布记录只引用检查结果和受保护的存放位置，不上传副本或清单。恢复时由持有主机权限的操作人按清单核对文件内容和部署路径，并按原有部署权限恢复。

这一步从下次发布开始执行。2026 年 11 月 18 日发布之前缺失的配置快照无法由发布后补拍的快照替代。
