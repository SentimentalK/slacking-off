# deploy/

第 5 步（PROJECT-126-F）的部署产物：单容器镜像（arm64）、K3s 清单、持久卷。

镜像把网页打进 `loo-server` 二进制（`include_dir!` 读取 `web/dist`），运行时不需要
`web/`、`node_modules/` 或任何静态目录；唯一的可写路径是数据卷 `/data`（以及 `TMPDIR`）。

## 构建镜像

构建上下文是仓库根；Web 在原生 `$BUILDPLATFORM` 上构建，Rust 用
`aarch64-linux-gnu-gcc` 交叉编译，只有最终 Debian 运行层是 `$TARGETPLATFORM`，
所以 Rust 编译不经过 qemu：

```sh
docker buildx build --platform linux/arm64 -f deploy/Dockerfile -t loo-server:f-arm64 .
docker image inspect loo-server:f-arm64 --format '{{.Architecture}}'   # arm64
```

## 本地运行

```sh
mkdir -p .conductor/deploy-data && chmod 777 .conductor/deploy-data
docker run --rm --platform linux/arm64 -p 18089:18080 \
  -v "$PWD/.conductor/deploy-data:/data" loo-server:f-arm64

curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18089/healthz      # 200 {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18089/             # 200: 内嵌 SPA
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18089/api/projection # 200: 公开投影
```

`/api/projection` 不需要登录，返回 `Envelope<Projection>` 的当前 tick；`/healthz`
同时是 K3s 的 readiness/liveness 探针。

把宿主目录挂到 `/data` 时，容器以 UID/GID `10001` 运行，宿主目录必须可写
（上面用 `chmod 777`；生产用 PVC，由 `fsGroup: 10001` 处理）。

## K3s

清单包含 `PersistentVolumeClaim`（1Gi、`ReadWriteOnce`）、`Deployment`
（1 副本、`Recreate`、30s 优雅退出）和 `ClusterIP` Service（18080）。
不写死 namespace，跟随当前 kubectl context；没有 `hostPath`。

```sh
# 无集群时只做客户端校验
kubectl apply --dry-run=client -f deploy/k3s.yaml
# 若已安装 kubeconform
kubeconform -strict deploy/k3s.yaml
# 有真集群（镜像需先推送到节点可拉取的仓库，并改 k3s.yaml 的 image）
kubectl apply -f deploy/k3s.yaml
```

`Deployment` 的容器 `image` 目前是本地标签 `loo-server:f-arm64`；上真集群前推送到
registry 并替换。`Ingress` 以注释形式附在清单末尾（stock K3s 用 `traefik` class），
取消注释后同样可 dry-run 通过。

`kubectl apply --dry-run=client` 仍然需要 API discovery 才能把 kind 映射到资源；
完全没有 kubeconfig 时会报 `dial tcp 127.0.0.1:8080`。本次没有接任何真实集群，
本地起了一个一次性 kind 控制面仅用于 discovery（用 `KUBECONFIG` 指过去），
`--dry-run=client` 通过后立即删除，没有 apply 任何对象。

**本次未接真集群，dry-run 通过**；`kubectl apply -f` 留给真实集群执行。

## 运行时默认值

| 项 | 值 |
| --- | --- |
| 模式 | `--official`（账号、哈希 token）；镜像入口固定为 official |
| 监听 | `--addr 0.0.0.0:18080`（容器内必须 0.0.0.0，CLI 默认是 `127.0.0.1:18080`） |
| 地图 | `--map /app/maps/default.txt`（镜像内 `maps/default.txt`） |
| 数据 | `--data-dir /data`，SQLite 文件 `/data/world.db` |
| 种子 | `--seed 42`（空数据目录首次建世界） |
| 其余 | `Config::default()`：tick 秒数等设计 §9 默认值，可用 `--config` / `--tick-seconds` 覆盖 |

## 卷与停止信号

- `/data` 是 `VOLUME`，K3s 里挂 PVC；`world.db`、事件日志与命令都在里面，单写者，
  所以固定 1 副本 + `Recreate`，绝不能两个 pod 同时写 SQLite 文件。
- `/tmp` 在 K3s 里是 `emptyDir`；容器根文件系统只读
  （`readOnlyRootFilesystem: true`），只放开 `/data` 与 `/tmp`。
- `STOPSIGNAL SIGTERM`（`docker stop` 也发 SIGTERM）：进程收到 SIGTERM 后优雅退出，
  先 `save_snapshot()` 再返回，下一次启动从快照恢复。`terminationGracePeriodSeconds: 30`
  给这条路径留时间；`docker stop` 默认 10s 也足够。
