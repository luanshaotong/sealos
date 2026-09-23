import axios from "axios";
import { useEffect, useState } from "react";

const App = () => {
  const [pageUrl, setPageUrl] = useState<string>('')
  const [error, setError] = useState<string>('')

  useEffect(() => {
    initPageUrl()
  }, [])

  const initPageUrl = async() => {
    try {
      const { data } = await axios.get('/api/platform/getEnv')
      const env = data?.data || data
      const protocol = env.monitorPageProtocol || 'http'
      const host = env.domain || window.location.hostname
      const port = env.monitorPagePort || '30971'
      const path = env.monitorPagePath || '/d/StarsL_cn_K8S/'
      const normalizedPath = path.startsWith('/') ? path : `/${path}`
      setPageUrl(`${protocol}://${host}:${port}${normalizedPath}`)
    } catch (err: any) {
      console.error('get monitor config failed', err)
      setError(err?.message || '监控地址获取失败')
    }
  }

  if (error) return <div style={{ padding: 16 }}>{error}</div>
  if (!pageUrl) return null

  return <iframe src={pageUrl} width={'100%'} height={'100%'} style={{ border: 0 }} />;
};

export default App;
