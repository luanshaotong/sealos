# applaunchpad 离线构建镜像接口测试数据

这个目录用于测试 applaunchpad 的构建镜像接口。

- `Dockerfile` 使用 `FROM scratch`，不会拉取基础镜像。
- `files/` 下是构建时需要拷贝进镜像的离线文件。
- `run-api-test.sh` 会按页面逻辑调用两步接口：
  - `/api/imagehub/uploadImageFile`
  - `/api/imagehub/buildDockerImage`

默认会构建并推送：

```text
sealos.hub:5000/default/offline-api-test:api-smoke
```
