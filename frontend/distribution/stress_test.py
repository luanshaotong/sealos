
import sqlite3

DATABASE = 'app.db'

def init_db():
    try:
        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        # 创建表的SQL语句
        cursor.execute('''
        CREATE TABLE IF NOT EXISTS results (
            id STRING PRIMARY KEY,
            test_type TEXT NOT NULL,
            namespace TEXT NOT NULL,
            appname TEXT NOT NULL,
            port INTEGER NOT NULL,
            core_interface TEXT NOT NULL,
            test_data TEXT NOT NULL,
            qps INTEGER NOT NULL,
            max_latency INTEGER NOT NULL,
            suggested_resources TEXT,
            max_usage_resources TEXT,
            average_latency INTEGER,
            status TEXT NOT NULL
        )
        ''')
        conn.commit()
        conn.close()
    except Exception as e:
        print('Error: ', e)
        return 'Error: ' + str(e)

# 压测ID: string
# 压测类型: string
# 命名空间: string
# 应用列表: [appname]
# 端口: int
# 核心接口: string
# 测试数据: string
# 期望的QPS: int
# 最大时延(ms): int
# def stress_test(id, test_type, namespace, appnames, port, core_interface, test_data, qps, max_latency):
#     conn = sqlite3.connect(DATABASE)
#     cursor = conn.cursor()
#     # 插入数据
#     cursor.execute('''
#     INSERT INTO results (id, test_type, namespace, appname, port, core_interface, test_data, qps, max_latency, status)
#     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
#     ''', (id, test_type, namespace, '|'.join(appnames), port, core_interface, test_data, qps, max_latency, 'processing'))
#     conn.commit()
#     conn.close()
#     return 'OK'

def mock_run_test(id):
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute('''
    UPDATE results SET status = 'success', suggested_resources = 'cpu: 1, memory: 1Gi | cpu: 2, memory: 4Gi ', max_usage_resources = 'cpu: 0.5, memory: 500Mi | cpu: 0.7, memory: 700Mi', average_latency = 100, status = 'success' WHERE id = ?
    ''', (id,))
    conn.commit()
    conn.close()
    return 'OK'

def list_results(id, test_type):
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    if id:
        if test_type:
            cursor.execute('''
            SELECT * FROM results WHERE id LIKE ? AND test_type = ?
            ''', (id, test_type))
        else:
            cursor.execute('''
            SELECT * FROM results WHERE id LIKE ?
            ''', (id,))
    else:
        if test_type:
            cursor.execute('''
            SELECT * FROM results WHERE test_type = ?
            ''', (test_type,))
        else:
            cursor.execute('''
            SELECT * FROM results
            ''')
    results = cursor.fetchall()
    conn.close()
    return results

def delete_result_by_id(id):
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute('''
    DELETE FROM results WHERE id = ?
    ''', (id,))
    conn.commit()
    conn.close()
    return 'OK'

import subprocess
import json
import requests
import shlex

def run_cmd(args, check=True):
    print('run command: ', ' '.join(shlex.quote(str(item)) for item in args))
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.stdout:
        print(result.stdout)
    if result.stderr:
        print(result.stderr)
    if check and result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or 'command failed')
    return result

def get_workload(appname, namespace):
    for workload_type in ['deployment', 'statefulset']:
        result = run_cmd([
            'kubectl',
            '-n',
            namespace,
            'get',
            workload_type,
            appname,
            '-o',
            'json',
            '--kubeconfig=/etc/kubernetes/admin.conf'
        ], check=False)
        if result.returncode == 0 and result.stdout.strip():
            return workload_type, json.loads(result.stdout)
    raise RuntimeError('未找到 Deployment 或 StatefulSet: {}/{}'.format(namespace, appname))

def change_resource(appname, namespace, cpu, memory):
    workload_type, json_data = get_workload(appname, namespace)

    containers = json_data['spec']['template']['spec'].get('containers', [])
    if not containers:
        raise RuntimeError('{} {} 没有容器配置'.format(workload_type, appname))

    for container in containers:
        resources = container.setdefault('resources', {})
        requests = resources.setdefault('requests', {})
        limits = resources.setdefault('limits', {})
        requests['cpu'] = cpu
        requests['memory'] = memory
        limits['cpu'] = cpu
        limits['memory'] = memory

    patch = {
        'spec': {
            'template': {
                'spec': {
                    'containers': containers
                }
            }
        }
    }

    run_cmd([
        'kubectl',
        '-n',
        namespace,
        'patch',
        workload_type,
        appname,
        '--type=merge',
        '-p',
        json.dumps(patch),
        '--kubeconfig=/etc/kubernetes/admin.conf'
    ])

def check_pod_status(appname, namespace):
    result = run_cmd([
        'kubectl',
        '-n',
        namespace,
        'get',
        'pods',
        '-l',
        'app={}'.format(appname),
        '-o',
        'json',
        '--kubeconfig=/etc/kubernetes/admin.conf'
    ], check=False)
    if result.returncode != 0:
        print('Pod not ready')
        return False

    pods = json.loads(result.stdout).get('items', [])
    if not pods:
        print('Pod not ready')
        return False

    for pod in pods:
        if pod.get('status', {}).get('phase') != 'Running':
            return False
        statuses = pod.get('status', {}).get('containerStatuses', [])
        if not statuses or not all(item.get('ready') for item in statuses):
            return False
    return True

def transform_cpu(cpu):
    if cpu.endswith('m'):
        return int(cpu[:-1]) / 1000
    return int(cpu)

def transform_memory(memory):
    if memory.endswith('Mi'):
        return int(memory[:-2]) / 1024
    return int(memory[:-2])

def get_pod_usage(appname, namespace):
    result = run_cmd([
        'kubectl',
        '-n',
        namespace,
        'top',
        'pod',
        '-l',
        'app={}'.format(appname),
        '--no-headers',
        '--kubeconfig=/etc/kubernetes/admin.conf'
    ], check=False)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or '获取 Pod 资源使用量失败')
    output = result.stdout.strip()
    if not output:
        raise RuntimeError('未获取到 Pod 资源使用量')
    lines = output.splitlines()
    total_cpu = 0
    total_memory = 0
    for line in lines:
        usages = line.split()
        if len(usages) < 3:
            continue
        total_cpu += transform_cpu(usages[1].strip())
        total_memory += transform_memory(usages[2].strip())
    print(usages)
    return total_cpu, total_memory

import asyncio
import aiohttp
import time
import threading
import os

INITIAL_CPU = float(os.getenv('STRESS_INITIAL_CPU_CORES', '0.1'))
INITIAL_MEMORY_GI = float(os.getenv('STRESS_INITIAL_MEMORY_GI', '0.125'))

def format_cpu(cpu):
    if cpu < 1:
        return '{}m'.format(int(cpu * 1000))
    return str(int(cpu)) if cpu == int(cpu) else str(cpu)

def format_memory(memory_gi):
    if memory_gi < 1:
        return '{}Mi'.format(int(memory_gi * 1024))
    return '{}Gi'.format(int(memory_gi)) if memory_gi == int(memory_gi) else '{}Gi'.format(memory_gi)

async def single_test(url, test_data, start_time):
    async with aiohttp.ClientSession() as session:
        # start_time = time.time()
        async with session.post(url, json=test_data) as response:
            await response.text()
            if response.status != 200:
                return 1e9
            latency = time.time() - start_time
            return latency

async def run_concurrent_test(url, test_data, qps):
    start_time = time.time()
    latencies = []
    for _ in range(30):
        tasks = [single_test(url, test_data, start_time) for _ in range(qps)]
        latencies = latencies + await asyncio.gather(*tasks)
        sleep_time = 1 - (time.time() - start_time)
        if sleep_time > 0:
            time.sleep(sleep_time)
        start_time = time.time()
    average_latency = sum(latencies) / len(latencies)
    print('Average latency: ', average_latency)
    return average_latency

async def run_concurrent_test_wrapper(url, test_data, qps):
    long_task = asyncio.create_task(run_concurrent_test(url, test_data, qps))
    try:
        result = await asyncio.wait_for(long_task, timeout=60)
    except asyncio.TimeoutError:
        return 1e9
    return result

def collect_usage(appname, namespace, results):
    max_cpu_usage = 0
    max_memory_usage = 0
    for i in range(60):
        try:
            cpu_usage, memory_usage = get_pod_usage(appname, namespace)
        except Exception as e:
            print('Error: ', e)
            time.sleep(1)
            continue
        max_cpu_usage = max(max_cpu_usage, cpu_usage)
        max_memory_usage = max(max_memory_usage, memory_usage)
        time.sleep(1)
    results[appname] = (max_cpu_usage, max_memory_usage)

def stress_test(id, test_type, namespace, appnames, port, url, test_data, qps, max_latency):
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute('''
    INSERT INTO results (id, test_type, namespace, appname, port, core_interface, test_data, qps, max_latency, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', (id, test_type, namespace, '|'.join(appnames), port, url, test_data, qps, max_latency, 'processing'))
    conn.commit()
    conn.close()

    thread = threading.Thread(target=stress_test_subprocess, args=(id, test_type, namespace, appnames, port, url, test_data, qps, max_latency))
    thread.start()
    return 'OK'

def mark_result_failed(id, reason=''):
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute('''
    UPDATE results SET status = 'failed', suggested_resources = ? WHERE id = ?
    ''', (reason, id))
    conn.commit()
    conn.close()

def stress_test_subprocess(id, test_type, namespace, appnames, port, url, test_data, qps, max_latency):
    try:
        return stress_test_subprocess_inner(id, test_type, namespace, appnames, port, url, test_data, qps, max_latency)
    except Exception as e:
        print('stress test failed: ', e)
        mark_result_failed(id, str(e))
        return 'Failed'

def stress_test_subprocess_inner(id, test_type, namespace, appnames, port, url, test_data, qps, max_latency):
    usages = {}
    max_usages = {}

    for appname in appnames:
        usages[appname] = [INITIAL_CPU, INITIAL_MEMORY_GI]
        change_resource(appname, namespace, format_cpu(INITIAL_CPU), format_memory(INITIAL_MEMORY_GI))
        
        ready = False
        for _ in range(100):
            time.sleep(1)
            if check_pod_status(appname, namespace):
                ready = True
                break
        if not ready:
            mark_result_failed(id, 'Pod 未就绪')
            print("result: ", list_results(id, test_type))
            return 'Failed'
        
        
        ready = False
        for _ in range(60):
            try:
                get_pod_usage(appname, namespace)
                ready = True
                break
            except Exception as e:
                print('Error: ', e)
                time.sleep(1)
        
        if not ready:
            mark_result_failed(id, '未获取到 Pod 资源使用量')
            print("result: ", list_results(id, test_type))
            return 'Failed'

    while True:
        any_scaled = False
        results = {}
        threads = []
        for appname in appnames:
            thread = threading.Thread(target=collect_usage, args=(appname, namespace, results))
            threads.append(thread)
            thread.start()

        latency = asyncio.run(run_concurrent_test_wrapper(url, test_data, qps))

        for thread in threads:
            thread.join()

        max_limit = False
        for appname, (cpu_usage, memory_usage) in results.items():
            max_usages[appname] = (cpu_usage * usages[appname][0], memory_usage * usages[appname][1])
            if cpu_usage/usages[appname][0] > 0.5 or memory_usage/usages[appname][1] > 0.9:
                any_scaled = True
                if usages[appname][0] >= 4 or usages[appname][1] >= 8:
                    max_limit = True
                    break
                usages[appname][0] = usages[appname][0] * 2
                usages[appname][1] = usages[appname][1] * 2
                change_resource(appname, namespace, format_cpu(usages[appname][0]), format_memory(usages[appname][1]))

                ready = False
                for _ in range(100):
                    time.sleep(1)
                    if check_pod_status(appname, namespace):
                        ready = True
                        break
                if not ready:
                    mark_result_failed(id, '扩容后 Pod 未就绪')
                    print("result: ", list_results(id, test_type))
                    return 'Failed'
                
                ready = False
                for _ in range(60):
                    try:
                        get_pod_usage(appname, namespace)
                        ready = True
                        break
                    except Exception as e:
                        print('Error: ', e)
                        time.sleep(1)
                
                if not ready:
                    mark_result_failed(id, '扩容后未获取到 Pod 资源使用量')
                    print("result: ", list_results(id, test_type))
                    return 'Failed'
        
        print('Latency: ', latency)
        if latency <= max_latency:
            break

        if not any_scaled:
            break
    
    if max_limit:
        suggested_resources = ' | '.join([f'cpu: {usages[appname][0]}, memory: {usages[appname][1]}Gi' for appname in appnames])
        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        cursor.execute('''
        UPDATE results SET status = 'failed', suggested_resources = ? WHERE id = ?
        ''', (id, suggested_resources))
        conn.commit()
        conn.close()

        print("result: ", list_results(id, test_type))
        return 'Failed'
    
    if latency > 1e8:
        conn = sqlite3.connect(DATABASE)
        cursor = conn.cursor()
        cursor.execute('''
        UPDATE results SET status = 'timeout' WHERE id = ?
        ''', (id,))
        conn.commit()
        conn.close()

        print("result: ", list_results(id, test_type))
        return 'Failed'

    suggested_resources = ' | '.join([f'cpu: {usages[appname][0]}, memory: {usages[appname][1]}Gi' for appname in appnames])
    max_usage_resources = ' | '.join([f'cpu: {max_usages[appname][0]}, memory: {max_usages[appname][1]}Gi' for appname in appnames])
    conn = sqlite3.connect(DATABASE)
    cursor = conn.cursor()
    cursor.execute('''
    UPDATE results SET status = 'completed', average_latency = ?, suggested_resources = ?, max_usage_resources = ? WHERE id = ?
    ''', (latency, suggested_resources, max_usage_resources, id))
    conn.commit()
    conn.close()

    print("result: ", list_results(id, test_type))
    return 'OK'

if __name__ == '__main__':
    init_db()
    # change_resource('nginx', 'test01', '2', '4Gi')
    # print(get_pod_usage('nginx', 'test01'))
    CLUSTER_DOMAIN = '192.168.0.134'
    STRESS_ID="test_stress_id_1"
    STRESS_TYPE="two"
    NAMESPACE="test01"
    APP_LIST="nginx,python-app-lst"
    PORT="32567"
    CORE_API="/test"
    TEST_DATA="1234"
    QPS=1000
    MAX_LATENCY=200
    url = f"http://{CLUSTER_DOMAIN}:{PORT}{CORE_API}"
    stress_test(STRESS_ID, STRESS_TYPE, NAMESPACE, APP_LIST.split(','), PORT, url, TEST_DATA, QPS, MAX_LATENCY)
