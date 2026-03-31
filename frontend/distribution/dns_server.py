import threading
import struct
import socket
from concurrent import futures
from custom_dns import get_all_dns_records, list_dns_rules

# DNS 记录类型编号
QTYPE_A = 1
QTYPE_AAAA = 28
QTYPE_CNAME = 5
QTYPE_TXT = 16
QTYPE_MX = 15
QTYPE_SRV = 33

RTYPE_MAP = {
    'A': QTYPE_A,
    'AAAA': QTYPE_AAAA,
    'CNAME': QTYPE_CNAME,
    'TXT': QTYPE_TXT,
    'MX': QTYPE_MX,
    'SRV': QTYPE_SRV,
}

RTYPE_REVERSE = {v: k for k, v in RTYPE_MAP.items()}

DNS_PORT = 5053
GRPC_PORT = 5054


# ==================== DNS 协议解析/构建工具 ====================

def decode_dns_name(data, offset):
    labels = []
    while True:
        length = data[offset]
        if length == 0:
            offset += 1
            break
        if (length & 0xC0) == 0xC0:
            pointer = struct.unpack('!H', data[offset:offset + 2])[0] & 0x3FFF
            sub_name, _ = decode_dns_name(data, pointer)
            labels.append(sub_name)
            offset += 2
            return '.'.join(labels), offset
        else:
            offset += 1
            labels.append(data[offset:offset + length].decode())
            offset += length
    return '.'.join(labels) + '.', offset


def encode_dns_name(name):
    result = b''
    if not name.endswith('.'):
        name += '.'
    for label in name.rstrip('.').split('.'):
        encoded = label.encode()
        result += bytes([len(encoded)]) + encoded
    result += b'\x00'
    return result


def parse_dns_query(data):
    header = struct.unpack('!HHHHHH', data[:12])
    qid = header[0]
    qdcount = header[2]

    offset = 12
    questions = []
    for _ in range(qdcount):
        qname, offset = decode_dns_name(data, offset)
        qtype, qclass = struct.unpack('!HH', data[offset:offset + 4])
        offset += 4
        questions.append((qname, qtype, qclass))

    return qid, questions


def build_dns_response(qid, questions, answers):
    flags = 0x8180  # QR=1, AA=1, RD=1, RA=1
    if not answers:
        flags = 0x8183  # NXDOMAIN

    header = struct.pack('!HHHHHH', qid, flags, len(questions), len(answers), 0, 0)

    question_section = b''
    for qname, qtype, qclass in questions:
        question_section += encode_dns_name(qname)
        question_section += struct.pack('!HH', qtype, qclass)

    answer_section = b''
    for ans in answers:
        answer_section += encode_dns_name(ans['name'])
        rdata = ans['rdata']
        answer_section += struct.pack('!HHIH', ans['rtype'], 1, ans['ttl'], len(rdata))
        answer_section += rdata

    return header + question_section + answer_section


def encode_rdata(record_type, value):
    if record_type == 'A':
        return socket.inet_aton(value)
    elif record_type == 'AAAA':
        return socket.inet_pton(socket.AF_INET6, value)
    elif record_type == 'CNAME':
        return encode_dns_name(value)
    elif record_type == 'TXT':
        encoded = value.encode()
        return bytes([len(encoded)]) + encoded
    elif record_type == 'MX':
        parts = value.split()
        priority = int(parts[0]) if len(parts) > 1 else 10
        exchange = parts[-1]
        return struct.pack('!H', priority) + encode_dns_name(exchange)
    return b''


# ==================== DNS UDP 服务器 ====================

class DnsUdpServer:
    def __init__(self, host='0.0.0.0', port=DNS_PORT):
        self.host = host
        self.port = port
        self.sock = None

    def handle_query(self, data):
        qid, questions = parse_dns_query(data)

        all_records = get_all_dns_records()
        answers = []

        for qname, qtype, qclass in questions:
            qname_lower = qname.lower()
            domain_records = all_records.get(qname_lower, [])

            type_name = RTYPE_REVERSE.get(qtype)
            for rec in domain_records:
                if type_name and rec['type'] == type_name:
                    rdata = encode_rdata(rec['type'], rec['value'])
                    if rdata:
                        answers.append({
                            'name': qname,
                            'rtype': RTYPE_MAP[rec['type']],
                            'ttl': rec['ttl'],
                            'rdata': rdata,
                        })

            # 如果查询 A 记录但只有 CNAME，返回 CNAME
            if not answers and qtype == QTYPE_A:
                for rec in domain_records:
                    if rec['type'] == 'CNAME':
                        rdata = encode_rdata('CNAME', rec['value'])
                        if rdata:
                            answers.append({
                                'name': qname,
                                'rtype': QTYPE_CNAME,
                                'ttl': rec['ttl'],
                                'rdata': rdata,
                            })

        return build_dns_response(qid, questions, answers)

    def serve(self):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind((self.host, self.port))
        print(f'DNS UDP server listening on {self.host}:{self.port}', flush=True)

        while True:
            try:
                data, addr = self.sock.recvfrom(512)
                response = self.handle_query(data)
                self.sock.sendto(response, addr)
            except Exception as e:
                print(f'DNS query error: {e}', flush=True)


# ==================== gRPC 服务器 ====================

def start_grpc_server(port=GRPC_PORT):
    try:
        import grpc
        import dns_service_pb2
        import dns_service_pb2_grpc

        class DnsServiceServicer(dns_service_pb2_grpc.DnsServiceServicer):
            def Lookup(self, request, context):
                domain = request.domain.lower()
                if not domain.endswith('.'):
                    domain += '.'
                record_type = request.record_type.upper() if request.record_type else None

                all_records = get_all_dns_records()
                domain_records = all_records.get(domain, [])

                result = []
                for rec in domain_records:
                    if record_type and rec['type'] != record_type:
                        continue
                    result.append(dns_service_pb2.DnsRecord(
                        domain=domain,
                        record_type=rec['type'],
                        value=rec['value'],
                        ttl=rec['ttl'],
                    ))

                return dns_service_pb2.DnsLookupResponse(
                    found=len(result) > 0,
                    records=result,
                )

            def GetAllRecords(self, request, context):
                all_records = get_all_dns_records()
                result = []
                for domain, records in all_records.items():
                    for rec in records:
                        result.append(dns_service_pb2.DnsRecord(
                            domain=domain,
                            record_type=rec['type'],
                            value=rec['value'],
                            ttl=rec['ttl'],
                        ))
                return dns_service_pb2.DnsRecordsResponse(records=result)

        server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
        dns_service_pb2_grpc.add_DnsServiceServicer_to_server(DnsServiceServicer(), server)
        server.add_insecure_port(f'0.0.0.0:{port}')
        server.start()
        print(f'DNS gRPC server listening on 0.0.0.0:{port}', flush=True)
        server.wait_for_termination()
    except ImportError:
        print('gRPC dependencies not installed, skipping gRPC server. Install: pip install grpcio grpcio-tools', flush=True)


# ==================== 启动入口 ====================

def start_dns_servers():
    """在后台线程中启动 DNS UDP 服务器和 gRPC 服务器"""
    dns_server = DnsUdpServer()
    dns_thread = threading.Thread(target=dns_server.serve, daemon=True)
    dns_thread.start()

    grpc_thread = threading.Thread(target=start_grpc_server, daemon=True)
    grpc_thread.start()

    return dns_thread, grpc_thread
