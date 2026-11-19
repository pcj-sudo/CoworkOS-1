"""Launch the installed Hermes API adapter without replacing its agent or tools."""
import asyncio
import os
import signal

from gateway.config import PlatformConfig
from gateway.platforms.api_server import APIServerAdapter


async def main():
    adapter = APIServerAdapter(PlatformConfig(enabled=True, extra={
        "host": "127.0.0.1", "port": int(os.environ["API_SERVER_PORT"]),
        "key": os.environ["API_SERVER_KEY"],
    }))
    if not await adapter.connect():
        raise RuntimeError("Hermes API server did not start")
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stopped.set)
    print("HERMES_FIXTURE_READY", flush=True)
    try:
        await stopped.wait()
    finally:
        await adapter.disconnect()


asyncio.run(main())
