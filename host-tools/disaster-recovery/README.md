# 数据库与原片备份检查

这两个只依赖 Python 标准库的工具运行于能读取照片目录、数据库备份和目标挂载的主机。实际复制另外使用已有的 `rsync`。它们不修改照片服务配置，不恢复生产数据库，不删除原片、旧备份或快照，也不发送通知。

Immich 的数据库备份只包含数据库；原片需要独立复制。参见 [官方备份与恢复说明](https://docs.immich.app/administration/backup-and-restore/)。外部图库也必须纳入保护范围，下面的默认目录只覆盖标准 `UPLOAD_LOCATION` 内的 `upload`、`library`、`profile`。

## 创建新的版本副本

先配置实际的独立目标挂载。下面的变量必须由操作者填写；目标目录必须已经存在，工具不会创建挂载或把缺失挂载悄悄替换成本机目录。

```sh
export MEDIA_ROOT='填写实际 UPLOAD_LOCATION'
export DATABASE_BACKUPS='填写实际数据库备份目录'
export BACKUP_DESTINATION='填写已经挂载的独立备份目录'

python3 host-tools/disaster-recovery/create-backup.py \
  --source-root "$MEDIA_ROOT" \
  --backup-dir "$DATABASE_BACKUPS" \
  --destination "$BACKUP_DESTINATION"
```

默认只检查并输出复制计划，不创建快照、不启动复制。确认目标和容量后，增加 `--apply` 才创建新副本：

```sh
python3 host-tools/disaster-recovery/create-backup.py \
  --source-root "$MEDIA_ROOT" \
  --backup-dir "$DATABASE_BACKUPS" \
  --destination "$BACKUP_DESTINATION" \
  --apply
```

每次执行使用新的 `mjora-时间-随机标识` 目录，复制原片目录和最新完成的例行数据库 `.sql.gz`。不使用 `--delete`，不覆盖以前版本，不设置自动保留清理。目标与源目录重叠或处于同一文件系统时会拒绝执行；空间不足、源含符号链接、数据库备份过期或损坏也会拒绝。外部图库需要另行明确源目录映射，不能把符号链接算作已备份的原片。

`--media-folder` 可重复指定根目录下的相对媒体目录，例如 `--media-folder library/selected --media-folder upload`。嵌套目录保留完整相对层级；末尾斜杠会规范化，重复或被父目录覆盖的选择只统计和复制一次。绝对路径、空目录、`..` 和路径中的符号链接均不作为允许的源映射。

复制后逐文件比较源与副本的 SHA-256，并核对数据库副本。只有检查通过才生成 `VERIFIED-FILES.json`；失败保留 `INCOMPLETE` 目录供检查，不自动删除任何已有数据。工具不在公开输出中列出照片文件名或基础设施路径。

检查会比较源与副本中实际目录、原片文件和所选数据库备份的文件系统，覆盖两侧的嵌套目录和单文件挂载。任一副本对象与受保护源共用文件系统时均拒绝通过；数据库副本也拒绝根目录以下任一父路径或文件符号链接。文件缺失、不可读或校验失败时，不会输出 `filesystemSeparated: true`。

**`filesystemSeparated` 只表示不同文件系统，不证明独立物理硬盘或异机。** 操作者需要确认目标的实际故障域，例如另一台机器的挂载或独立硬盘。同一物理盘的另一个分区仍可能一起损坏。

新硬盘首次接入时，在照片服务宿主机做以下验收：

1. 用只读的 `findmnt --target "$MEDIA_ROOT"`、`findmnt --target "$DATABASE_BACKUPS"`、`findmnt --target "$BACKUP_DESTINATION"` 和 `lsblk -o NAME,TYPE,PKNAME,TRAN,SIZE,MOUNTPOINTS` 核对实际挂载和底层设备。另查参与备份的嵌套挂载或外部图库。源和目标必须没有共同的物理盘；LVM、RAID 或多设备文件系统要核对全部成员。设备映射不清楚时停止。还要确认目标挂载点确实挂载了这块盘，避免把未挂载的空目录当作目标。
2. 先运行默认预演，确认原片范围、数据库备份和可用容量。按下方的协调备份步骤生成第一个版本；记录快照标识、文件校验结果和独立设备核对结果。
3. 从该快照恢复到隔离数据库，并从**副本路径**读取原片样本。只在这两项通过后记录首次恢复验收通过，再安排自动复制及失败提醒。首次验收前，状态仍是 `replica_not_configured` 或“已配置、未验收”；不要以原盘读测或文件校验代替恢复。

**文件校验通过不等于数据库和原片属于同一时点，也不等于应用恢复成功。** 默认使用现有数据库备份和复制时的原片；并发上传、删除、外部图库写入仍可能造成两者不一致。记录始终包含 `pointInTimeConsistency: "not-established"`，不能据此宣称完整应用恢复通过。

需要可恢复的协调备份时，按以下顺序执行：

1. 安排维护窗口，暂停所有客户端写入、后台上传、删除任务、外部图库写入和存储侧修改；具体暂停方法由部署者按实际拓扑执行，工具不自动停止服务。
2. 使用现有管理界面或既有备份任务创建一份新的数据库备份，确认成功完成，保留数据库版本和时间记录。
3. 保持写入暂停，先运行计划，再运行 `--apply`。保留新快照及 `VERIFIED-FILES.json`。
4. 完成下面的隔离数据库恢复和原片抽查，把结果与该快照关联记录；然后恢复写入。

## 只读健康检查

```sh
python3 host-tools/disaster-recovery/check-backup.py \
  --source-root "$MEDIA_ROOT" \
  --backup-dir "$DATABASE_BACKUPS" \
  --replica-root "$BACKUP_SNAPSHOT"
```

`BACKUP_SNAPSHOT` 指某一次版本目录，内含 `backups`、`upload` 等子目录。工具输出一行 JSON，检查最新例行备份的新鲜度（默认 36 小时，可用 `--max-age-hours` 修改）、gzip 校验、PostgreSQL dump 标记、原片文件数量和摘要、对应数据库副本及文件系统隔离。退出码 `0` 表示这些文件检查通过，`1` 表示需要处理；不会输出“完整灾备已完成”。全量摘要读取会产生磁盘 I/O，建议在空闲时段运行。

未提供 `--replica-root` 时仍可检查本机数据库备份，但一定输出 `critical` 和 `replica_not_configured`，避免把仅有数据库备份当成完整保护。返回值可接入现有监控；本工具不安装定时任务或外发告警。

对旧快照执行检查会与**当前**源文件和最新数据库备份比较，因此可能报告差异。旧快照的历史文件校验记录保存在其 `VERIFIED-FILES.json`，仍需要保留对应的独立恢复记录。

## 隔离恢复演练

恢复必须使用单独的数据库容器和空卷，不向生产容器执行 SQL。使用与备份相同主要版本、所需扩展一致的**已有镜像 ID**；不为演练拉取或升级镜像。PostgreSQL plain SQL dump 应通过 `psql` 恢复，非 plain 格式才使用 `pg_restore`，参见 [PostgreSQL 官方说明](https://www.postgresql.org/docs/current/app-pgrestore.html)。

以下命令中的 `DATABASE_BACKUP_FILE`、`DATABASE_USER`、`DATABASE_NAME`、`POSTGRES_IMAGE_ID` 需要由操作者填写并 `export`，其中 `DATABASE_BACKUP_FILE` 必须指向已选定的副本内备份文件：

```sh
export DRILL_RUN="mjora-drill-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')"
export DRILL_CONTAINER="$DRILL_RUN"
export DRILL_VOLUME="${DRILL_CONTAINER}-data"

docker volume create --label "mjora.disaster.task=$DRILL_RUN" "$DRILL_VOLUME"

docker run --detach --name "$DRILL_CONTAINER" \
  --label "mjora.disaster.task=$DRILL_RUN" \
  --network none --memory 1536m --cpus 1 --pids-limit 128 \
  --security-opt no-new-privileges --shm-size 128m \
  --mount "type=volume,source=$DRILL_VOLUME,destination=/var/lib/postgresql/data" \
  --mount "type=bind,source=$DATABASE_BACKUP_FILE,destination=/backup.sql.gz,readonly" \
  --env POSTGRES_PASSWORD=isolated-drill-only \
  --env "POSTGRES_USER=$DATABASE_USER" --env "POSTGRES_DB=$DATABASE_NAME" \
  "$POSTGRES_IMAGE_ID" postgres -c shared_preload_libraries=vchord.so

docker exec "$DRILL_CONTAINER" pg_isready -U "$DATABASE_USER" -d "$DATABASE_NAME"
```

`DRILL_CONTAINER`、`DRILL_VOLUME` 必须是本次新生成且未使用的唯一名称。上面的扩展启动参数对应当前使用的 VectorChord 镜像；其他镜像按原有 PostgreSQL 参数调整。启动前核对内存、磁盘容量和备份大小，给任务设置操作超时。容器不绑定端口、不连接生产网络、不挂载生产数据库目录或原片，也不运行 Immich 应用和自动任务。

准备完成后，用 Python 管道检查两个进程的退出状态；不依赖 shell 管道最后一个进程掩盖解压失败：

```sh
python3 - <<'PY'
import os, subprocess
name = os.environ['DRILL_CONTAINER']
unzip = subprocess.Popen(['docker', 'exec', name, 'gzip', '-dc', '/backup.sql.gz'], stdout=subprocess.PIPE)
try:
    restore = subprocess.run(['docker', 'exec', '-i', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1',
                              '--single-transaction', '-U', os.environ['DATABASE_USER'],
                              '-d', os.environ['DATABASE_NAME']], stdin=unzip.stdout, timeout=600)
    unzip.stdout.close()
    unzip_result = unzip.wait(timeout=20)
    if restore.returncode != 0 or unzip_result != 0:
        raise RuntimeError('Isolated database restore or archive decompression failed')
finally:
    if unzip.poll() is None:
        unzip.kill()
        unzip.wait()
PY
```

验证应包括：备份 COPY 数据与恢复库逐表行数一致、约束和索引有效、扩展可用，以及从恢复库引用的副本原片抽样读取并核对字节数/摘要。只检查 gzip 不能证明数据库可恢复，只读取生产原片也不能证明副本可恢复。记录真实通过范围后，核对任务标签并仅删除自己创建的容器和卷：

```sh
python3 - <<'PY'
import json, os, subprocess
run = os.environ['DRILL_RUN']
container = os.environ['DRILL_CONTAINER']
volume = os.environ['DRILL_VOLUME']
if not run or not container.startswith('mjora-drill-') or container != run or volume != container + '-data':
    raise RuntimeError('A unique drill identity is required for cleanup')
info = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]
disk = json.loads(subprocess.check_output(['docker', 'volume', 'inspect', volume]))[0]
if (info['Config'].get('Labels') or {}).get('mjora.disaster.task') != run:
    raise RuntimeError('Container task identity differs; refusing cleanup')
if (disk.get('Labels') or {}).get('mjora.disaster.task') != run:
    raise RuntimeError('Volume task identity differs; refusing cleanup')
subprocess.run(['docker', 'rm', '--force', container], check=True)
subprocess.run(['docker', 'volume', 'rm', volume], check=True)
PY
```

## 本地回归

```sh
python3 -m unittest discover -s host-tools/disaster-recovery -p 'test_*.py' -v
```

测试仅使用临时合成文件，包括真实 `rsync` 版本复制、默认预演无写入、旧版本保留、同文件系统与目录重叠拒绝、缺失/损坏/过期备份、原片摘要变化、符号链接和非零健康状态。
