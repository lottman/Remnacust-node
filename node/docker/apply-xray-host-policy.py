from pathlib import Path
import sys
root = Path(sys.argv[1])
p = root / 'app/dispatcher/default.go'
s = p.read_text()
for before, after in [
    ('\treturn inboundLink, outboundLink\n', '\tapplyHostPolicy(ctx, inboundLink, outboundLink)\n\treturn inboundLink, outboundLink\n'),
    ('\treturn link\n', '\tapplyHostPolicy(ctx, link, nil)\n\treturn link\n'),
]:
    if after in s: continue
    assert s.count(before) == 1, before
    s = s.replace(before, after, 1)
p.write_text(s)
