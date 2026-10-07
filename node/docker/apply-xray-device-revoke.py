#!/usr/bin/env python3
"""Patch the pinned upstream Xray tag to close links by authenticated email."""

from pathlib import Path
import sys


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text()
    if text.count(old) != 1:
        raise SystemExit(f"unexpected upstream layout in {path}: {old!r}")
    path.write_text(text.replace(old, new, 1))


root = Path(sys.argv[1])
dispatcher = root / "app/dispatcher/default.go"
command = root / "app/proxyman/command/command.go"

replace_once(
    dispatcher,
    "if user != nil && len(user.Email) > 0 {\n\t\tp := d.policy.ForLevel(user.Level)",
    "if user != nil && len(user.Email) > 0 {\n\t\ttrackUserLink(ctx, user.Email, inboundLink, outboundLink)\n\t\tp := d.policy.ForLevel(user.Level)",
)
replace_once(
    dispatcher,
    "if user != nil && len(user.Email) > 0 {\n\t\tp := policyManager.ForLevel(user.Level)",
    "if user != nil && len(user.Email) > 0 {\n\t\ttrackUserLink(ctx, user.Email, link, nil)\n\t\tp := policyManager.ForLevel(user.Level)",
)
replace_once(command, '"github.com/xtls/xray-core/app/commander"',
             '"github.com/xtls/xray-core/app/commander"\n\t"github.com/xtls/xray-core/app/dispatcher"')
replace_once(command, "\treturn um.AddUser(ctx, mUser)\n", "\tif err := um.AddUser(ctx, mUser); err != nil {\n\t\treturn err\n\t}\n\tdispatcher.AllowUserLinks(mUser.Email)\n\treturn nil\n")
replace_once(command, "\treturn um.RemoveUser(ctx, op.Email)\n", "\tif um.GetUser(ctx, op.Email) != nil {\n\t\tif err := um.RemoveUser(ctx, op.Email); err != nil {\n\t\t\treturn err\n\t\t}\n\t}\n\tdispatcher.RevokeUserLinks(op.Email)\n\treturn nil\n")
