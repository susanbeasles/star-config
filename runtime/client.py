#!/usr/bin/python3 -I
"""Unprivileged client; authorization and execution policy live in the controller."""

import json
import os
import socket
import sys

SOCKET = "/opt/agent-guard/control.sock"
MAX_BYTES = 65536
MAX_EXIT_STATUS = 255


def main():
    if sys.argv[1:2] != ["check"] or not sys.argv[2:3]:
        raise ValueError("Usage: agent-guard check pre-commit|pre-push|post-edit")
    phase = sys.argv[2]
    text = sys.stdin.read(MAX_BYTES + 1) if phase in {"pre-push", "post-edit"} else ""
    request = {"phase": phase, "args": sys.argv[3:], "stdin": text}
    request["cwd"] = os.getcwd()
    data = (json.dumps(request) + "\n").encode()
    if len(data) > MAX_BYTES:
        raise ValueError("Request limit exceeded")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(1230)
        connection.connect(SOCKET)
        connection.sendall(data)
        response = bytearray()
        while not response.endswith(b"\n"):
            block = connection.recv(4096)
            if not block or len(response) + len(block) > 4 * 1024 * 1024:
                raise ValueError("Invalid controller response")
            response.extend(block)
    result = json.loads(response)
    sys.stdout.write(result.get("output", ""))
    if result.get("proposal"):
        sys.stderr.write("Review required: " + result["proposal"] + "\n")
    return (
        result["status"]
        if isinstance(result.get("status"), int) and 0 <= result["status"] <= MAX_EXIT_STATUS
        else 1
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, TypeError) as error:
        sys.stderr.write(
            "agent-guard is unavailable or refused the request; "
            "no checkout fallback is permitted (" + type(error).__name__ + ").\n"
        )
        raise SystemExit(127) from None
