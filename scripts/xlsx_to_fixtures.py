#!/usr/bin/env python3
import sys
import os
import json
import re
from zipfile import ZipFile
import xml.etree.ElementTree as ET


JP_TO_KEY = {
    '商品名': 'name',
    '製造会社': 'maker',
    '販売会社': 'distributor',
    '蒸溜所': 'distillery',
    'タイプ': 'category',
    '熟成期間': 'maturationPeriod',
    '熟成地': 'maturationPlace',
    '樽種': 'caskType',
    '樽番号': 'caskNumber',
    '度数': 'alcoholVolume',
    '本数': 'availableBottles',
    '30ml': 'price30ml',
    '15ml': 'price15ml',
    '10ml': 'price10ml',
    '備考': 'notes',
    '国': 'country',
    '現行': 'currentFlag',
    'ピート感': 'peat',
}


def col_letters_to_index(letters: str) -> int:
    idx = 0
    for ch in letters:
        idx = idx * 26 + (ord(ch) - ord('A') + 1)
    return idx - 1


def get_text_from_shared(shared, idx):
    try:
        return shared[idx]
    except Exception:
        return ''


def parse_shared_strings(z: ZipFile):
    shared = []
    try:
        with z.open('xl/sharedStrings.xml') as f:
            tree = ET.parse(f)
        root = tree.getroot()
        # namespace handling
        for si in root.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si'):
            # compose text from possibly multiple t nodes
            texts = []
            for t in si.findall('.//{http://schemas.openxmlformats.org/spreadsheetml/2006/main}t'):
                texts.append(t.text or '')
            shared.append(''.join(texts))
    except KeyError:
        pass
    return shared


def parse_first_sheet_rows(z: ZipFile, shared):
    # assume first worksheet is sheet1.xml; fallback to workbook.xml lookup if needed
    sheet_xml_name = 'xl/worksheets/sheet1.xml'
    try:
        with z.open(sheet_xml_name) as f:
            tree = ET.parse(f)
    except KeyError:
        # try to resolve from workbook.xml
        with z.open('xl/workbook.xml') as f:
            wb = ET.parse(f)
        ns = {'ns': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
        sheet = wb.getroot().find('.//ns:sheets/ns:sheet', ns)
        if sheet is None:
            raise RuntimeError('workbook.xml にシート情報が見つかりません')
        rel_id = sheet.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
        # relationships to find actual path
        with z.open('xl/_rels/workbook.xml.rels') as f:
            rels = ET.parse(f).getroot()
        target = None
        for rel in rels:
            if rel.attrib.get('Id') == rel_id:
                target = rel.attrib.get('Target')
                break
        if not target:
            raise RuntimeError('シートのパスが解決できません')
        sheet_xml_name = 'xl/' + target
        with z.open(sheet_xml_name) as f:
            tree = ET.parse(f)

    root = tree.getroot()
    ns = {'ns': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
    rows = []
    for row in root.findall('.//ns:sheetData/ns:row', ns):
        cells = {}
        for c in row.findall('ns:c', ns):
            r = c.attrib.get('r')  # e.g., A1
            if not r:
                continue
            col_letters = re.match(r'([A-Z]+)', r).group(1)
            col_idx = col_letters_to_index(col_letters)
            cell_type = c.attrib.get('t')
            v = c.find('ns:v', ns)
            is_node = c.find('ns:is/ns:t', ns)
            text = ''
            if cell_type == 's' and v is not None and v.text is not None:
                text = get_text_from_shared(shared, int(v.text))
            elif cell_type == 'inlineStr' and is_node is not None:
                text = is_node.text or ''
            elif v is not None and v.text is not None:
                text = v.text
            else:
                text = ''
            cells[col_idx] = text
        rows.append(cells)
    return rows


def slugify(s: str) -> str:
    ascii_slug = re.sub(r'-+', '-', re.sub(r'[^a-z0-9]+', '-', s.lower())).strip('-')
    if ascii_slug:
        return ascii_slug
    # Fallback: keep unicode, replace whitespaces with '-'
    return re.sub(r'\s+', '-', s.strip())


def split_tags(s: str):
    if not s:
        return []
    parts = re.split(r'[、,\/\s・]+', s)
    return [p for p in (part.strip() for part in parts) if p]


def classify_abv(s: str):
    if s is None or s == '':
        return None
    try:
        val = float(str(s).replace('%', ''))
    except Exception:
        return None
    if val <= 1.5:
        val *= 100
    if val < 40:
        return 'low'
    if val <= 46:
        return 'mid'
    return 'high'


def classify_price(s: str):
    if not s:
        return None
    try:
        val = float(re.sub(r'[^0-9.]', '', str(s)))
    except Exception:
        return None
    if val < 1200:
        return 'low'
    if val <= 2000:
        return 'mid'
    return 'high'


def to_number(s: str):
    if s is None or s == '':
        return None
    try:
        return float(re.sub(r'[^0-9.]', '', str(s)))
    except Exception:
        return None


def main(xlsx_path: str, out_dir: str):
    with ZipFile(xlsx_path) as z:
        shared = parse_shared_strings(z)
        rows = parse_first_sheet_rows(z, shared)

    if not rows:
        print('シートが空です', file=sys.stderr)
        sys.exit(1)

    # ヘッダ取得
    header_cells = rows[0]
    # 配列 index => ヘッダ文字列
    max_col = max(header_cells.keys()) if header_cells else -1
    headers = []
    for i in range(max_col + 1):
        headers.append(header_cells.get(i, ''))

    def get(row, key_jp):
        # ヘッダ名から列インデックスを探して値を取得
        try:
            idx = headers.index(key_jp)
        except ValueError:
            return ''
        return row.get(idx, '')

    items = []
    makers = set()
    seq = 0

    for row_cells in rows[1:]:
        # スキップ条件: 商品名が空
        name = get(row_cells, '商品名') or ''
        if not name.strip():
            continue
        seq += 1
        maker = (get(row_cells, '製造会社') or get(row_cells, '販売会社') or get(row_cells, '蒸溜所') or '').strip()
        makers.add(maker) if maker else None

        # alcohol volume in % (handle 0.43 => 43)
        raw_abv = get(row_cells, '度数')
        abv_num = to_number(raw_abv)
        if abv_num is not None and abv_num <= 1.5:
            abv_num = round(abv_num * 100, 2)

        item = {
            'id': f'DRK-{seq:04d}',
            'status': 'Published' if '終売' not in (get(row_cells, '現行') or '') else 'Draft',
            'name': name.strip(),
            'maker': maker,
            'makerSlug': slugify(maker) if maker else '',
            'category': (get(row_cells, 'タイプ') or 'その他').strip(),
            'tags': list(filter(None, split_tags(get(row_cells, 'ピート感')))),
            'description': (get(row_cells, '備考') or f"{maker} {name}").strip(),
            'aiSuggestedDescription': None,
            'aiSuggestedImageUrl': None,
            'imageUrl': '',
            'aiStatus': 'Approved',  # フィクスチャとして表示用
            'approveFlag': 'Approved',
            'approvedBy': None,
            'approvedAt': None,
            'updatedAt': None,
            'country': (get(row_cells, '国') or '').strip(),
            'manufacturer': (get(row_cells, '製造会社') or '').strip(),
            'distributor': (get(row_cells, '販売会社') or '').strip(),
            'distillery': (get(row_cells, '蒸溜所') or '').strip(),
            'type': (get(row_cells, 'タイプ') or '').strip(),
            'caskNumber': (get(row_cells, '樽番号') or '').strip(),
            'caskType': (get(row_cells, '樽種') or '').strip(),
            'maturationPlace': (get(row_cells, '熟成地') or '').strip(),
            'maturationPeriod': (get(row_cells, '熟成期間') or '').strip(),
            'alcoholVolume': abv_num,
            'availableBottles': to_number(get(row_cells, '本数')),
            'price30ml': to_number(get(row_cells, '30ml')),
            'price15ml': to_number(get(row_cells, '15ml')),
            'price10ml': to_number(get(row_cells, '10ml')),
            'notes': (get(row_cells, '備考') or '').strip(),
        }
        # クラス分類
        item['abvClass'] = classify_abv(raw_abv)
        item['priceClass'] = classify_price(get(row_cells, '30ml'))

        items.append(item)

    menu_json = {
        'items': items,
        'total': len(items),
        'updatedAt': __import__('datetime').datetime.now().isoformat()
    }

    makers_json = {
        'makers': sorted([m for m in makers if m])
    }

    os.makedirs(out_dir, exist_ok=True)
    with open(os.path.join(out_dir, 'menu.sample.json'), 'w', encoding='utf-8') as f:
        json.dump(menu_json, f, ensure_ascii=False, indent=2)
    with open(os.path.join(out_dir, 'makers.sample.json'), 'w', encoding='utf-8') as f:
        json.dump(makers_json, f, ensure_ascii=False, indent=2)

    print(f"生成しました: {out_dir}/menu.sample.json, {out_dir}/makers.sample.json")


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('使い方: python scripts/xlsx_to_fixtures.py <path-to-xlsx> [out_dir]', file=sys.stderr)
        sys.exit(1)
    xlsx_path = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) >= 3 else 'data/fixtures'
    main(xlsx_path, out_dir)
