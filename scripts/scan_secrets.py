#!/usr/bin/env python3
"""既知の形の秘密情報が、コードや git 履歴に混ざっていないか調べる。

## なぜ必要か

2026-06、Gemini の API キー3つが `static/firebase-config.js` と `.env` に
入ったままコミットされた。現在のファイルからは消えているが、**git 履歴は
公開リポジトリで誰でも読める**ため、公開してから約2か月半のあいだ読める
状態だった（2026-08-29 に運営者が Console で3つとも無効化）。

原因は「同じキーを Firebase の `apiKey` と `GEMINI_API_KEY` の両方に
使っていた」こと。**Gemini が有効なキーがブラウザに配信されていた**ので、
公開リポジトリでなくても漏れていた。

人が気をつけるだけでは再発する。コミットの追加行を機械で見る。

## この検査の限界

**「見つからなかった」は「無い」ではない。** 既知の形（`AIza` で始まる、
`sk_live_` で始まる…）しか見つけられない。ランダム文字列のパスワードなど、
形に特徴の無い秘密は取りこぼす。

除外語（`dummy` `example` `your-` など）を含む行は設定例とみなして飛ばすので、
**そういう語をたまたま含む本物も見逃す。** 除外しないと設定例で埋まって
読めなくなるため、承知のうえで割り切っている。

## Firebase の apiKey は秘密ではない

`AIza` で始まるので混同しやすいが、**Firebase の `apiKey` は公開前提の値**。
ブラウザに配信されるので隠せないし、隠す必要もない（安全性は Firestore の
セキュリティルールと Authentication が担保する）。消すと動かなくなるだけ。

そのため `static/firebase-config.js` の `apiKey:` 行だけは例外として通す。
**それ以外の場所に現れる `AIza` は、たとえ同じ値でも報告する** — 用途ごとに
キーを分ける決まりなので、他所に出てくること自体が間違い。

## 使い方

    python3 scripts/scan_secrets.py                    # 追跡中のファイルを見る
    python3 scripts/scan_secrets.py --range main..HEAD # コミット範囲の追加行だけ
    python3 scripts/scan_secrets.py --history          # 全履歴（初回・公開前）

見つかると終了コード 1。**値そのものは出力しない**（記録が漏洩の再生産に
なるため）。出るのは場所と種類と先頭数文字だけ。
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys
from dataclasses import dataclass

# 既知の形。名前は報告にそのまま出る。
PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("Google API キー",        re.compile(r"AIza[0-9A-Za-z_-]{35}")),
    ("Stripe 本番キー",         re.compile(r"sk_live_[0-9A-Za-z]{20,}")),
    ("Stripe Webhook 署名鍵",   re.compile(r"whsec_[0-9A-Za-z]{20,}")),
    ("GitHub トークン",         re.compile(r"gh[pousr]_[0-9A-Za-z]{36,}")),
    ("AWS アクセスキー",        re.compile(r"AKIA[0-9A-Z]{16}")),
    ("Slack トークン",          re.compile(r"xox[baprs]-[0-9A-Za-z-]{10,}")),
    ("秘密鍵ファイル",          re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----")),
    ("資格情報つき接続URL",     re.compile(r"[a-z][a-z0-9+.-]*://[^\s:@/]+:[^\s:@/]+@[^\s/]+")),
    ("秘密の代入",              re.compile(
        r"(?i)\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|client[_-]?secret|password|passwd)\b"
        r"\s*[:=]\s*[\"'][^\"'\s]{16,}[\"']")),
]

# 設定例・プレースホルダを示す語。行に含まれていれば飛ばす。
PLACEHOLDERS = re.compile(
    r"(?i)dummy|example|sample|placeholder|your[-_]|xxx|<[^>]+>|\.\.\.|"
    r"process\.env|os\.environ|getenv|secrets\.|\$\{|import\.meta\.env|"
    r"changeme|test[-_]?key|fake"
)

def _diff_path(line: str) -> str:
    """diff の `+++` 行からファイルパスを取り出す。

    **非ASCIIのファイル名は git が引用符つき・8進エスケープで書く。**
    素朴に先頭6文字を落とす実装だと path が取れず、下の ALLOW
    （パスで判定する）が黙って効かなくなる。このリポジトリは日本語の
    ファイル名を使うので、必ず通る経路。
    """
    body = line[4:]
    if body.startswith('"') and body.endswith('"'):
        raw = body[1:-1].encode("latin-1", "backslashreplace")
        body = raw.decode("unicode_escape").encode("latin-1", "replace").decode("utf-8", "replace")
    return body[2:] if body.startswith("b/") else body


# 公開前提の値。ここだけは通す（理由は上の docstring）。
ALLOW = [
    # Firebase の apiKey は隠せないし隠す必要もない。
    (re.compile(r"^static/firebase-config\.js$"), re.compile(r"^\s*apiKey\s*:")),
    # この検査自身。パターン定義を秘密と読んでしまう。
    (re.compile(r"^scripts/scan_secrets\.py$"), re.compile(r".")),
    (re.compile(r"^tests/test_scan_secrets\.py$"), re.compile(r".")),
]


@dataclass(frozen=True)
class Finding:
    where: str      # "path:行番号" か "コミット:path"
    kind: str
    hint: str       # 値そのものではなく、先頭4文字と長さ

    def __str__(self) -> str:
        return f"{self.where}: {self.kind} — {self.hint}"


def _mask(value: str) -> str:
    """値は出さない。先頭4文字と長さだけ返す。"""
    head = value[:4]
    return f"{head}…（{len(value)}文字）"


def _allowed(path: str, line: str) -> bool:
    return any(p.search(path) and l.search(line) for p, l in ALLOW)


def _cited_in_docs(path: str, line: str, value: str) -> bool:
    """ドキュメントが検査対象の「形」を引用している箇所か。

    この検査の説明そのものが秘密鍵のヘッダ表記などを含むため、放っておくと
    **自分の説明で NG になる**。落ちる検査は無効化されるので、静かに
    することも要件のうち。

    通すのは `.md` の中で、**バッククォートで囲まれている**表記だけ。
    値が素で貼られていれば囲まれていないので止まる。
    **裏を返すと、バッククォートで囲んで貼られた本物は見逃す。**
    """
    if not path.endswith(".md"):
        return False
    return any(value in m.group(1) for m in re.finditer(r"`([^`]*)`", line))


def scan_line(path: str, line: str) -> list[tuple[str, str]]:
    """1行を照合して [(種類, マスク済みの手がかり)] を返す。"""
    if PLACEHOLDERS.search(line) or _allowed(path, line):
        return []
    out = []
    for kind, pat in PATTERNS:
        m = pat.search(line)
        if m and not _cited_in_docs(path, line, m.group(0)):
            out.append((kind, _mask(m.group(0))))
    return out


def _git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], check=True, capture_output=True, text=True, errors="replace"
    ).stdout


def scan_worktree() -> list[Finding]:
    """追跡中のテキストファイルを見る。"""
    found = []
    for path in _git("ls-files").splitlines():
        if not path:
            continue
        try:
            body = subprocess.run(
                ["git", "show", f"HEAD:{path}"], capture_output=True, text=True, errors="replace"
            ).stdout
        except Exception:
            continue
        for n, line in enumerate(body.splitlines(), 1):
            for kind, hint in scan_line(path, line):
                found.append(Finding(f"{path}:{n}", kind, hint))
    return found


def scan_diff(rev_range: str) -> list[Finding]:
    """コミット範囲の**追加行だけ**を見る。PR で使う。"""
    out = _git("diff", "--unified=0", "--no-color", rev_range)
    found, path = [], "?"
    for line in out.splitlines():
        if line.startswith("+++ "):
            path = _diff_path(line)
        elif line.startswith("+") and not line.startswith("+++"):
            for kind, hint in scan_line(path, line[1:]):
                found.append(Finding(path, kind, hint))
    return found


def scan_history(ref: str = "HEAD") -> list[Finding]:
    """全コミットの追加行を見る。初回と、公開に切り替える前に。"""
    found = []
    for sha in _git("rev-list", ref).split():
        out = _git("show", "--unified=0", "--no-color", "--format=", sha)
        path = "?"
        for line in out.splitlines():
            if line.startswith("+++ "):
                path = _diff_path(line)
            elif line.startswith("+") and not line.startswith("+++"):
                for kind, hint in scan_line(path, line[1:]):
                    found.append(Finding(f"{sha[:8]}:{path}", kind, hint))
    return found


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--range", help="コミット範囲（例 main..HEAD）の追加行だけ見る")
    g.add_argument("--history", nargs="?", const="HEAD",
                   help="全履歴を見る。公開に切り替える前に必ず1回")
    args = ap.parse_args()

    if args.range:
        found, what = scan_diff(args.range), f"{args.range} の追加行"
    elif args.history:
        found, what = scan_history(args.history), "全履歴"
    else:
        found, what = scan_worktree(), "追跡中のファイル"

    if not found:
        print(f"[OK] {what}に、既知の形の秘密情報は見つからなかった。")
        print("     ただし形に特徴の無い秘密は見つけられない（詳細は本ファイルの説明）。")
        return 0

    print(f"[NG] {what}に {len(found)} 件見つかった。値は出力しない。", file=sys.stderr)
    for f in found:
        print(f"  {f}", file=sys.stderr)
    print(file=sys.stderr)
    print("  対処: (1) その資格情報を発行元で無効化する（履歴の書き換えより先）", file=sys.stderr)
    print("        (2) コードから消し、環境変数から読むよう直す", file=sys.stderr)
    print("        (3) 公開前提の値なら scripts/scan_secrets.py の ALLOW に理由つきで足す",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
