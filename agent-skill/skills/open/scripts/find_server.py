"""Print the URL of the running Jupyter server whose root is the given folder."""

import os
import sys

from jupyter_server.serverapp import list_running_servers

target = os.path.realpath(sys.argv[1])
for info in list_running_servers():
    # Other apps (the MCP server) write jpserver-*.json files too; only
    # Jupyter Server writes base_url.
    if "base_url" not in info or os.path.realpath(info["root_dir"]) != target:
        continue
    url = info["url"] + "lab"
    if info.get("token"):
        url += "?token=" + info["token"]
    print(url)
    break
