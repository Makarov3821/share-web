# share-web

一个面向局域网的文本和文件共享网页。服务端使用 Rust，前端使用原生 HTML/CSS/JavaScript；程序不依赖 Docker，也不要求运行在 ImmortalWrt 上。

## 本地运行

需要 Rust stable 工具链：

```sh
cargo run -- \
  --listen 127.0.0.1:8080 \
  --data-dir ./data \
  --max-total-size 10G \
  --max-upload-size 2G
```

然后访问 <http://127.0.0.1:8080>。

容量参数支持纯字节和常见单位：`B`、`K`、`KiB`、`M`、`MiB`、`G`、`GiB`、`T`、`TiB`。`0` 表示不限制。

例如部署到挂载盘：

```sh
./share-web \
  --listen 0.0.0.0:8080 \
  --data-dir /mnt/storage/share-web \
  --max-total-size 100G \
  --max-upload-size 4G
```

`--max-total-size` 统计已提交的文件和剪切板文字。上传先写入 `data-dir/tmp`，容量检查通过后才移动到 `data-dir/objects`。

## HTTP API

```text
GET    /api/items
POST   /api/files                 multipart 字段：file
GET    /api/files/{id}/download
POST   /api/clips                 JSON：{"text":"..."}
PATCH  /api/items/{id}            JSON：{"expiresAt":  unix 秒时间戳或 null}
DELETE /api/items/{id}
GET    /api/health
```

## 数据迁移

停止服务后，直接复制整个 `data-dir` 到新机器，再使用新的 `--data-dir` 启动即可。数据目录中包含 `metadata.json`、`objects/` 和 `tmp/`；启动时会清理临时文件、过期项目和无引用对象。

## 域名和反向代理

应用不修改 DNS 或防火墙。可以在局域网 DNS 中将 `share.f` 解析到服务所在机器，再使用 Nginx/Caddy 将 80/443 转发到应用监听端口。ImmortalWrt 和 NAS 只需要分别提供 procd/systemd 启动配置。

## 当前状态

第一版已经包含：

- 双栏卡片界面；
- 文件拖拽和选择上传；
- 文件下载；
- Ctrl+V 创建剪切板文字；
- 点击文字卡片复制；
- 单卡片过期时间设置和删除；
- 总空间、单文件和单条文字大小限制；
- 后台过期清理和启动时数据整理。

访问控制、CIDR 限制、认证、HTTPS、OpenWrt procd 和 NAS systemd 示例属于后续阶段。
