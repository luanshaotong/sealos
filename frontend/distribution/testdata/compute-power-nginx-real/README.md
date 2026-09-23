# 算力测算真实请求用例

这个用例用于验证 applaunchpad 算力测算会真实请求业务接口，并能写入测算结果。

用例内容：

- 构建本地 nginx 镜像 `sealos.hub:5000/default/compute-power-nginx-real:api-test`
- nginx 监听 `8080`，`POST /api` 返回 `200`
- 部署到 `default` 命名空间
- 暴露 NodePort `31280`
- 调用 applaunchpad API 创建测算任务
- 轮询 `/api/node/computePower`，等待状态变成 `completed` 或 `failed`

执行：

```bash
./run-api-test.sh
```

结果文件会写在本目录：

- `login-response.json`
- `create-response.json`
- `result-response.json`
- `request-check.txt`
