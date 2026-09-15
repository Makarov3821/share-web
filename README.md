# share-web

一个面向局域网的轻量文本和文件共享网页。它使用 Rust 编写后端，前端使用原生 HTML/CSS/JavaScript，页面资源会在编译时嵌入可执行文件中，因此不依赖 Docker、数据库或特定路由器平台。

项目可以直接运行在 ImmortalWrt、普通 Linux 主机或 NAS 上。只要让局域网 DNS/网关把一个域名（例如 `share.f`）转发到它监听的 HTTP 端口即可。

## 功能

- 文件拖入页面任意位置上传，也可以使用文件选择器；支持一次上传多个文件。
- 文件卡片点击下载，文字卡片点击复制到剪切板。
- 桌面端直接使用 `Ctrl/Command+V` 创建文字卡片；移动端可以在文字输入框粘贴，回车保存，`Shift+Enter` 换行。
- 每个文件或文字卡片都可以设置永久保存、快捷过期时长或自定义过期时间，到期后自动清理。
- 帮助弹层、删除确认弹层，以及深色、浅色、跟随系统三种主题。
- 主题偏好按客户端 IP 保存；无法使用服务端偏好时会回退到浏览器本地保存。
- 可设置总使用空间、单文件大小和单条文字大小限制。
- 数据目录是普通文件，可整体复制到另一台机器迁移。

## 从源码运行

需要 Rust stable 工具链（Rust 1.85 或更新版本）：

```sh
cargo run --release -- \
  --listen 0.0.0.0:8080 \
  --data-dir ./data \
  --max-total-size 10GiB \
  --max-upload-size 2GiB \
  --max-clip-size 1MiB
```

然后访问 <http://127.0.0.1:8080>，或从局域网其他设备访问运行主机的地址。

生产环境也可以直接运行编译产物：

```sh
cargo build --release
./target/release/share-web --data-dir /mnt/storage/share-web
```

## 命令行参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--listen` | `0.0.0.0:8080` | HTTP 监听地址 |
| `--data-dir` | `./data` | 持久化数据目录 |
| `--max-total-size` | `0` | 文件和文字的总空间上限；`0` 表示不限制 |
| `--max-upload-size` | `0` | 单个文件上限；`0` 表示不限制 |
| `--max-clip-size` | `1MiB` | 单条文字上限 |
| `--cleanup-interval` | `60` | 后台清理过期项目的间隔，单位为秒 |
| `--trust-proxy` | 关闭 | 信任反向代理传入的第一个 `X-Forwarded-For` 地址 |

容量参数支持纯字节和以下单位：`B`、`K`、`KiB`、`M`、`MiB`、`G`、`GiB`、`T`、`TiB`。例如 `100G`、`10GiB`、`512MiB`。

`--trust-proxy` 只应在应用端口无法被客户端直接访问，并且 Nginx/Caddy 等可信代理会覆盖 `X-Forwarded-For` 时启用。否则客户端可以伪造该请求头，导致主题偏好写入错误的 IP 条目。

## Docker

构建镜像：

```sh
docker build -t share-web:1.0.0 .
```

容器内的 `/data` 是持久化目录。使用宿主机挂载盘时，先确保它能被镜像中的 `shareweb` 用户（UID `10001`）读写：

```sh
mkdir -p ./data
sudo chown -R 10001:10001 ./data
```

启动一个局域网可访问的实例：

```sh
docker run -d \
  --name share-web \
  --restart unless-stopped \
  -p 8080:8080 \
  -v "$(pwd)/data:/data" \
  share-web:1.0.0 \
  --listen 0.0.0.0:8080 \
  --data-dir /data \
  --max-total-size 100GiB \
  --max-upload-size 4GiB
```

容器默认执行：

```text
share-web --listen 0.0.0.0:8080 --data-dir /data
```

传入参数会替换镜像默认的 `CMD`；自定义启动时建议显式保留 `--listen 0.0.0.0:8080 --data-dir /data`，再追加其他参数（例如 `--cleanup-interval 300`）。镜像只包含运行时所需的二进制和 CA 证书，数据不会写入容器层。

## 域名和反向代理

应用本身不修改 DNS、防火墙或网关路由。部署流程通常是：

1. 在局域网 DNS 中将 `share.f` 解析到运行 share-web 的主机。
2. 让网关或反向代理把该域名的 HTTP/HTTPS 请求转发到 `127.0.0.1:8080`（或容器映射出的端口）。
3. 只有在反向代理覆盖 `X-Forwarded-For` 且应用端口不对局域网直接开放时，才添加 `--trust-proxy`。

Caddy 示例：

```caddyfile
share.f {
    reverse_proxy 127.0.0.1:8080
}
```

Nginx 示例：

```nginx
server {
    listen 80;
    server_name share.f;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

## 数据目录和迁移

服务会在 `data-dir` 下创建：

```text
data-dir/
├── metadata.json       # 文件/文字卡片元数据
├── preferences.json    # 按客户端 IP 保存的主题偏好
├── objects/            # 实际上传文件
└── tmp/                # 上传中的临时文件
```

停止服务后，直接复制整个数据目录到新机器，再通过新的 `--data-dir` 启动即可。启动时会清理临时文件、过期项目和没有元数据引用的孤儿文件。

## HTTP API

```text
GET    /api/health
GET    /api/items
POST   /api/files                 multipart 字段：file
GET    /api/files/{id}/download
POST   /api/clips                 JSON：{"text":"..."}
PATCH  /api/items/{id}            JSON：{"expiresAt": unix 秒时间戳或 null}
DELETE /api/items/{id}
GET    /api/preferences            获取当前客户端主题偏好
PATCH  /api/preferences            JSON：{"theme":"system|dark|light"}
```

文件上传先写入 `tmp/`，完成容量检查后再移动到 `objects/`。过期清理和删除会同时移除对应文件对象，避免长期占用空间。

## 开发和检查

```sh
cargo fmt
cargo check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build --release
node --check static/app.js
```

当前版本面向可信局域网使用，尚未提供用户认证、CIDR 访问控制、HTTPS 证书管理、审计日志或 OpenWrt `procd`/NAS `systemd` 示例。若需要将服务暴露到不可信网络，建议先置于带认证和 HTTPS 的反向代理之后。
