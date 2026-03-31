import sqlite3
import re
import ipaddress

DNS_DATABASE = 'dns.db'


def init_dns_db():
    conn = sqlite3.connect(DNS_DATABASE)
    cursor = conn.cursor()
    cursor.execute('''
    CREATE TABLE IF NOT EXISTS dns_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        domain TEXT NOT NULL,
        record_type TEXT NOT NULL DEFAULT 'A',
        value TEXT NOT NULL,
        ttl INTEGER NOT NULL DEFAULT 3600,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    ''')
    cursor.execute('''
    CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_type_value
    ON dns_rules (domain, record_type, value)
    ''')
    conn.commit()
    conn.close()


def _get_conn():
    conn = sqlite3.connect(DNS_DATABASE)
    conn.row_factory = sqlite3.Row
    return conn


VALID_RECORD_TYPES = {'A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV'}
DOMAIN_REGEX = re.compile(
    r'^(\*\.)?([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}\.?$'
)


def _validate_domain(domain):
    if not domain or len(domain) > 253:
        return False
    if not domain.endswith('.'):
        domain = domain + '.'
    return bool(DOMAIN_REGEX.match(domain))


def _validate_value(record_type, value):
    if record_type == 'A':
        try:
            ipaddress.IPv4Address(value)
            return True
        except ValueError:
            return False
    elif record_type == 'AAAA':
        try:
            ipaddress.IPv6Address(value)
            return True
        except ValueError:
            return False
    elif record_type == 'CNAME':
        return _validate_domain(value)
    elif record_type in ('TXT', 'MX', 'SRV'):
        return bool(value and value.strip())
    return False


def _normalize_domain(domain):
    domain = domain.strip().lower()
    if not domain.endswith('.'):
        domain = domain + '.'
    return domain


def list_dns_rules(domain=None, record_type=None):
    conn = _get_conn()
    cursor = conn.cursor()
    query = 'SELECT * FROM dns_rules WHERE 1=1'
    params = []
    if domain:
        query += ' AND domain = ?'
        params.append(_normalize_domain(domain))
    if record_type:
        query += ' AND record_type = ?'
        params.append(record_type.upper())
    query += ' ORDER BY domain, record_type'
    cursor.execute(query, params)
    rules = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return rules


def add_dns_rule(domain, record_type, value, ttl=3600):
    domain = _normalize_domain(domain)
    record_type = record_type.upper()

    if not _validate_domain(domain):
        return None, '无效的域名格式'

    if record_type not in VALID_RECORD_TYPES:
        return None, f'不支持的记录类型: {record_type}，支持: {", ".join(sorted(VALID_RECORD_TYPES))}'

    if not _validate_value(record_type, value):
        return None, f'无效的记录值: {value} (类型: {record_type})'

    if not isinstance(ttl, int) or ttl < 1 or ttl > 86400:
        return None, 'TTL 必须在 1-86400 之间'

    conn = _get_conn()
    cursor = conn.cursor()
    try:
        cursor.execute(
            'INSERT INTO dns_rules (domain, record_type, value, ttl) VALUES (?, ?, ?, ?)',
            (domain, record_type, value, ttl)
        )
        rule_id = cursor.lastrowid
        conn.commit()
        cursor.execute('SELECT * FROM dns_rules WHERE id = ?', (rule_id,))
        rule = dict(cursor.fetchone())
        return rule, None
    except sqlite3.IntegrityError:
        return None, f'规则已存在: {domain} {record_type} {value}'
    finally:
        conn.close()


def update_dns_rule(rule_id, domain=None, record_type=None, value=None, ttl=None):
    conn = _get_conn()
    cursor = conn.cursor()

    cursor.execute('SELECT * FROM dns_rules WHERE id = ?', (rule_id,))
    existing = cursor.fetchone()
    if not existing:
        conn.close()
        return None, '规则不存在'

    new_domain = _normalize_domain(domain) if domain else existing['domain']
    new_record_type = record_type.upper() if record_type else existing['record_type']
    new_value = value if value else existing['value']
    new_ttl = ttl if ttl is not None else existing['ttl']

    if domain and not _validate_domain(new_domain):
        conn.close()
        return None, '无效的域名格式'

    if record_type and new_record_type not in VALID_RECORD_TYPES:
        conn.close()
        return None, f'不支持的记录类型: {new_record_type}'

    if value and not _validate_value(new_record_type, new_value):
        conn.close()
        return None, f'无效的记录值: {new_value} (类型: {new_record_type})'

    if ttl is not None and (not isinstance(new_ttl, int) or new_ttl < 1 or new_ttl > 86400):
        conn.close()
        return None, 'TTL 必须在 1-86400 之间'

    try:
        cursor.execute(
            '''UPDATE dns_rules
               SET domain = ?, record_type = ?, value = ?, ttl = ?, updated_at = CURRENT_TIMESTAMP
               WHERE id = ?''',
            (new_domain, new_record_type, new_value, new_ttl, rule_id)
        )
        conn.commit()
        cursor.execute('SELECT * FROM dns_rules WHERE id = ?', (rule_id,))
        rule = dict(cursor.fetchone())
        return rule, None
    except sqlite3.IntegrityError:
        return None, f'规则冲突: {new_domain} {new_record_type} {new_value}'
    finally:
        conn.close()


def delete_dns_rule(rule_id):
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM dns_rules WHERE id = ?', (rule_id,))
    existing = cursor.fetchone()
    if not existing:
        conn.close()
        return False, '规则不存在'

    cursor.execute('DELETE FROM dns_rules WHERE id = ?', (rule_id,))
    conn.commit()
    conn.close()
    return True, None


def get_all_dns_records():
    """供 gRPC 服务调用，返回所有 DNS 记录，按域名分组"""
    conn = _get_conn()
    cursor = conn.cursor()
    cursor.execute('SELECT domain, record_type, value, ttl FROM dns_rules ORDER BY domain')
    rows = cursor.fetchall()
    conn.close()

    records = {}
    for row in rows:
        domain = row['domain']
        if domain not in records:
            records[domain] = []
        records[domain].append({
            'type': row['record_type'],
            'value': row['value'],
            'ttl': row['ttl'],
        })
    return records
