from flask import Flask, request, jsonify, Response
import subprocess
import os
import json
import yaml
import time
import shutil
import zipfile

app = Flask(__name__)

# 环境变量：集群域名
CLUSTER_DOMAIN = os.getenv('CLUSTER_DOMAIN')
# 环境变量：镜像仓库地址
REGISTRY_URL = os.getenv('REGISTRY_URL')
# 环境变量：镜像仓库用户名
REGISTRY_USER = os.getenv('REGISTRY_USER')
# 环境变量：镜像仓库密码
REGISTRY_PASS = os.getenv('REGISTRY_PASS')
# 环境变量：文件保存路径
SAVE_PATH = os.getenv('SAVE_PATH')

# 辅助函数：执行shell命令
def run_command(command):
    try:
        subprocess.run(command, shell=True, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return None
    except subprocess.CalledProcessError as e:
        print("Error executing command: " + e.stderr.decode().strip())
        return e.stderr.decode().strip()

def upload_deploy_helper(file_path, namespace, appname, images):
    for image in images:
        image['path'] = os.path.join(file_path, image['path'].split('/')[-1])
    with open(os.path.join(file_path, 'app.yaml'), 'r') as file:
        yaml_content = file.read()

    new_yaml_contents = []
    for single_yaml in yaml.safe_load_all(yaml_content):
        if 'kind' in single_yaml and single_yaml['kind'] == 'Deployment':
            if 'spec' in single_yaml and 'template' in single_yaml['spec'] and 'spec' in single_yaml['spec']['template']:
                if 'containers' in single_yaml['spec']['template']['spec']:
                    for container_index in range(len(single_yaml['spec']['template']['spec']['containers'])):
                        container = single_yaml['spec']['template']['spec']['containers'][container_index]
                        if 'image' in container:
                            if not '/' in container['image']:
                                container['image'] = 'library/' + container['image']
                            if not ':' in container['image']:
                                container['image'] = container['image'] + ':latest'
        new_yaml_contents.append(single_yaml)
    new_yaml_content = yaml.dump_all(new_yaml_contents)


    print('deployAppWithImage, appname:', appname, 'namespace:', namespace, flush=True)

    # 加载和推送镜像
    for image in images:
        name = image['name'].strip()
        path = image['path']

        # 登录镜像仓库
        err = run_command('docker login -u admin -p passw0rd sealos.hub:5000')
        if err:
            return jsonify({'error': 'Failed to login, ' + err}), 500

        # 加载镜像
        err = run_command('docker load -i ' + path)
        if err:
            return jsonify({'error': 'Failed to load image, ' + err}), 500
        # 替换域名并推送镜像
        parts = name.split('/')
        if len(parts) == 3:
            new_name = 'sealos.hub:5000/' + '/'.join(parts[1:])
        elif len(parts) == 1:
            new_name = 'sealos.hub:5000/library/' + name
        elif len(parts) == 2:
            new_name = 'sealos.hub:5000/' + name
        else:
            return jsonify({'error': 'Invalid image name: ' + name}), 400
        err = run_command('docker tag ' + name + ' ' + new_name)
        if err:
            return jsonify({'error': 'Failed to tag image, ' + err}), 500
        err = run_command('docker push ' + new_name)
        if err:
            return jsonify({'error': 'Failed to push image, ' + err}), 500

    # 替换yaml中的CLUSTER_DOMAIN
    new_yaml_content = new_yaml_content.replace('CLUSTER_DOMAIN', CLUSTER_DOMAIN)
    with open('temp.yaml', 'w') as file:
        file.write(new_yaml_content)

    # 调用kubectl创建命名空间
    create_namespace_command = 'kubectl create namespace ' + namespace + ' --kubeconfig=/etc/kubernetes/admin.conf'
    err = run_command(create_namespace_command)

    if err:
        if 'already exists' not in err:
            return jsonify({'error': 'Failed to create namespace, ' + err}), 500

    # 调用kubectl部署应用
    apply_command = 'kubectl apply -n ' + namespace + ' --kubeconfig=/etc/kubernetes/admin.conf -f temp.yaml'
    err = run_command(apply_command)

    if err:
        return jsonify({'error': 'Failed to apply application, ' + err}), 500

    # 返回成功响应
    detail_url = 'http://' + CLUSTER_DOMAIN + ':32293/app/detail'
    return jsonify({'message': 'Application deployed successfully', 'url': detail_url}), 200

# API端点：导出应用程序
@app.route('/api/exportApp', methods=['POST'])
def export_app():
    # 获取请求参数 应用编排yaml，应用镜像列表，应用名称，命名空间
    yaml_content = request.json.get('yaml')
    if not yaml_content:
        return jsonify({'error': 'YAML is required'}), 400
    images = request.json.get('images')
    if not images:
        return jsonify({'error': 'Images are required'}), 400
    appname = request.args.get('appname')
    if not appname:
        return jsonify({'error': 'Appname is required'}), 400
    namespace = request.args.get('namespace')
    if not namespace:
        return jsonify({'error': 'Namespace is required'}), 400

    print('exportApp, appname:', request.args.get('appname'), 'namespace:', request.args.get('namespace'), flush=True)

    workdir = os.path.join(SAVE_PATH, namespace, appname)
    
    if os.path.exists(workdir):
        os.system('rm -rf ' + workdir)
    os.makedirs(workdir)

    # 保存yaml文件至本地
    print('write yaml file to:', os.path.join(workdir, 'app.yaml'), flush=True)
    with open(os.path.join(workdir, 'app.yaml'), 'w') as file:
        file.write(yaml_content)

    # 检索yaml中的所有nodeport端口和对应的内部port
    nodeports = []
    for single_yaml in yaml.safe_load_all(yaml_content):
        if 'kind' in single_yaml and single_yaml['kind'] == 'Service':
            if 'spec' in single_yaml and 'type' in single_yaml['spec'] and single_yaml['spec']['type'] == 'NodePort':
                for port_index in range(len(single_yaml['spec']['ports'])):
                    nodeports.append({'internal_port': str(single_yaml['spec']['ports'][port_index]['port']), 'external_port': ''})
    print('nodeports:', nodeports, flush=True)

    image_pairs = []
    
    # 登录镜像仓库
    print('login to registry', flush=True)
    err = run_command('docker login -u admin -p passw0rd sealos.hub:5000')
    if err:
        return jsonify({'error': 'Failed to login, ' + err}), 500
    
    # 拉取镜像并保存到本地
    for image in images:
        name = image['name'].strip()
        print('pull image:', name, flush=True)
        image_file_name = name.replace('/', '_').replace(':', '_') + '.tar'
        path = os.path.join(workdir, image_file_name)
        image_pairs.append({'name': name, 'path': path})
        err = run_command('docker pull ' + name)
        if err:
            return jsonify({'error': 'Failed to pull image, ' + err}), 500
        print('save image:', name, flush=True)
        err = run_command('docker save ' + name + ' -o ' + path)
        if err:
            return jsonify({'error': 'Failed to save image, ' + err}), 500
    
    # 保存元数据信息
    metadata = {
        'name': appname,
        'namespace': namespace,
        'images': image_pairs,
        'nodeports': nodeports
    }
    with open(os.path.join(workdir, 'metadata.json'), 'w') as file:
        file.write(json.dumps(metadata))
    
    # 返回成功响应
    return jsonify({'message': 'Application exported successfully', 'path': workdir, 'url': 'http://' + CLUSTER_DOMAIN + ':5002/api/downloadApp?appname=' + appname + '&namespace=' + namespace}), 200

# API端点：打包并下载应用程序
@app.route('/api/downloadApp', methods=['GET'])
def download_app():
    # 获取请求参数
    appname = request.args.get('appname')
    if not appname:
        return jsonify({'error': 'Appname is required'}), 400
    namespace = request.args.get('namespace')
    if not namespace:
        return jsonify({'error': 'Namespace is required'}), 400

    print('downloadApp, appname:', appname, 'namespace:', namespace, flush=True)

    # 打包应用程序为zip文件
    workdir = os.path.join(SAVE_PATH, namespace, appname)
    zip_path = os.path.join(SAVE_PATH, namespace, appname + '.zip')
    shutil.make_archive(base_name=os.path.splitext(zip_path)[0], format='zip', root_dir=workdir)

    # 以流的形式返回文件
    def generate():
        with open(zip_path, 'rb') as file:
            while True:
                data = file.read(1024)
                if not data:
                    break
                yield data

    response = Response(generate(), content_type='application/zip')
    response.headers['Content-Disposition'] = 'attachment; filename=' + appname + '.zip'
    return response

# API端点：上传应用程序
@app.route('/api/uploadApp', methods=['POST'])
def upload_app():
    # 检查文件上传
    if 'file' not in request.files:
        return jsonify({'error': 'No file part in the request'}), 400

    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected for uploading'}), 400

    # 检查并创建保存路径
    workdir = os.path.join(SAVE_PATH, 'temp')
    if not os.path.exists(workdir):
        os.makedirs(workdir)

    # 保存上传的zip文件
    zip_path = os.path.join(workdir, file.filename)
    file.save(zip_path)
    print('Saved file to:', zip_path, flush=True)

    # 解压上传的zip文件
    try:
        with zipfile.ZipFile(zip_path, 'r') as zip_ref:
            zip_ref.extractall(workdir)
        print('Extracted zip file successfully.', flush=True)
    except zipfile.BadZipFile as e:
        return jsonify({'error': 'Failed to extract zip file, ' + str(e)}), 500

    # 删除上传的zip文件以释放空间
    os.remove(zip_path)

    # 读取元数据文件（如存在）
    metadata_path = os.path.join(workdir, 'metadata.json')
    if os.path.exists(metadata_path):
        with open(metadata_path, 'r') as file:
            metadata = json.load(file)
        namespace = metadata['namespace']
        appname = metadata['name']
        images = metadata['images']
        print('Loaded metadata:', metadata, flush=True)
    else:
        metadata = {}

    new_workdir = os.path.join(SAVE_PATH, namespace, appname)
    if not os.path.exists(new_workdir):
        os.makedirs(new_workdir)

    # 移动 workdir 下的所有内容到 new_workdir
    for item in os.listdir(workdir):
        src_path = os.path.join(workdir, item)
        dest_path = os.path.join(new_workdir, item)
        shutil.move(src_path, dest_path)

    # 删除工作目录
    os.rmdir(workdir)

    deploy_response = upload_deploy_helper(new_workdir, namespace, appname, images)

    # 返回成功响应
    return jsonify({'message': 'Application uploaded and extracted successfully', 'metadata': metadata}), 200

# API端点：部署应用程序
@app.route('/api/deployAppWithImage', methods=['POST'])
def deploy_app_with_image():
    # 获取请求参数
    file_path = request.json.get('path')
    if not file_path:
        return jsonify({'error': 'Path is required'}), 400  
    ports = request.json.get('ports')
    if not ports:
        return jsonify({'error': 'Ports are required'}), 400
    namespace = request.args.get('namespace')
    with open(os.path.join(file_path, 'metadata.json'), 'r') as file:
        metadata = json.load(file)
    appname = metadata['name']
    if not namespace:
        namespace = metadata['namespace']
    images = metadata['images']
    for image in images:
        image['path'] = os.path.join(file_path, image['path'].split('/')[-1])
    with open(os.path.join(file_path, 'app.yaml'), 'r') as file:
        yaml_content = file.read()

    new_yaml_contents = []
    for single_yaml in yaml.safe_load_all(yaml_content):
        if 'kind' in single_yaml and single_yaml['kind'] == 'Service':
            if 'spec' in single_yaml and 'type' in single_yaml['spec'] and single_yaml['spec']['type'] == 'NodePort':
                for port_index in range(len(single_yaml['spec']['ports'])):
                    internal_port = str(single_yaml['spec']['ports'][port_index]['port'])
                    if internal_port not in ports.keys():
                        return jsonify({'error': 'ExternalPort for InternalPort ' + internal_port + ' is required'}), 400
                    # check if ports[internal_port] is int
                    if not isinstance(ports[internal_port], int):
                        return jsonify({'error': 'ExternalPort for InternalPort ' + internal_port + ' should be int'}), 400
                    # check if ports[internal_port] is 30000-32767
                    if ports[internal_port] < 30000 or ports[internal_port] > 32767:
                        return jsonify({'error': 'ExternalPort for InternalPort ' + internal_port + ' should be between 30000 and 32767'}), 400
                    single_yaml['spec']['ports'][port_index]['nodePort'] = ports[internal_port]
        if 'kind' in single_yaml and single_yaml['kind'] == 'Deployment':
            if 'spec' in single_yaml and 'template' in single_yaml['spec'] and 'spec' in single_yaml['spec']['template']:
                if 'containers' in single_yaml['spec']['template']['spec']:
                    for container_index in range(len(single_yaml['spec']['template']['spec']['containers'])):
                        container = single_yaml['spec']['template']['spec']['containers'][container_index]
                        if 'image' in container:
                            if not '/' in container['image']:
                                container['image'] = 'library/' + container['image']
                            if not ':' in container['image']:
                                container['image'] = container['image'] + ':latest'
        new_yaml_contents.append(single_yaml)
    new_yaml_content = yaml.dump_all(new_yaml_contents)


    print('deployAppWithImage, appname:', appname, 'namespace:', namespace, flush=True)
    # if not namespace:
    #     return jsonify({'error': 'Namespace is required'}), 400
    # appname = request.args.get('appname')
    # if not appname:
    #     return jsonify({'error': 'Appname is required'}), 400
    # images = request.json.get('images')
    # if not images:
    #     return jsonify({'error': 'Images are required'}), 400
    # yaml_content = request.json.get('yaml')
    # if not yaml_content:
    #     return jsonify({'error': 'YAML is required'}), 400

    # 加载和推送镜像
    for image in images:
        name = image['name'].strip()
        path = image['path']

        # 登录镜像仓库
        err = run_command('docker login -u admin -p passw0rd sealos.hub:5000')
        if err:
            return jsonify({'error': 'Failed to login, ' + err}), 500

        # 加载镜像
        err = run_command('docker load -i ' + path)
        if err:
            return jsonify({'error': 'Failed to load image, ' + err}), 500
        # 替换域名并推送镜像
        parts = name.split('/')
        if len(parts) == 3:
            new_name = 'sealos.hub:5000/' + '/'.join(parts[1:])
        elif len(parts) == 1:
            new_name = 'sealos.hub:5000/library/' + name
        elif len(parts) == 2:
            new_name = 'sealos.hub:5000/' + name
        else:
            return jsonify({'error': 'Invalid image name: ' + name}), 400
        err = run_command('docker tag ' + name + ' ' + new_name)
        if err:
            return jsonify({'error': 'Failed to tag image, ' + err}), 500
        err = run_command('docker push ' + new_name)
        if err:
            return jsonify({'error': 'Failed to push image, ' + err}), 500

    # 替换yaml中的CLUSTER_DOMAIN
    new_yaml_content = new_yaml_content.replace('CLUSTER_DOMAIN', CLUSTER_DOMAIN)
    with open('temp.yaml', 'w') as file:
        file.write(new_yaml_content)

    # 调用kubectl创建命名空间
    create_namespace_command = 'kubectl create namespace ' + namespace + ' --kubeconfig=/etc/kubernetes/admin.conf'
    err = run_command(create_namespace_command)

    if err:
        if 'already exists' not in err:
            return jsonify({'error': 'Failed to create namespace, ' + err}), 500

    # 调用kubectl部署应用
    apply_command = 'kubectl apply -n ' + namespace + ' --kubeconfig=/etc/kubernetes/admin.conf -f temp.yaml'
    err = run_command(apply_command)

    if err:
        return jsonify({'error': 'Failed to apply application, ' + err}), 500

    # 返回成功响应
    detail_url = 'http://' + CLUSTER_DOMAIN + ':32293/app/detail?namespace=' + namespace + '&&name=' + appname
    return jsonify({'message': 'Application deployed successfully', 'url': detail_url}), 200

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5002)