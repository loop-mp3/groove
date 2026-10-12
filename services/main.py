import asyncio
import json
import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uvicorn

app = FastAPI(title="Groove Override API")

# The override console may be served from a different local or hosted origin.
# Keep this open for the local tool; credentials are intentionally disabled so
# the wildcard origin remains valid.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = Path(__file__).resolve().parent / "db" / "overrides.json"
dbLock = asyncio.Lock()

INSTRUMENTAL_SYMBOLS = ["♪", "♫", "♪"]


class TrackOverride(BaseModel):
    trackId: str = Field(min_length=1)
    lyricsId: str | None = None
    provider: str = Field(min_length=1)
    instrumental: bool = False


def loadDatabase() -> dict[str, list[Any]]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    if not DB_PATH.exists():
        return {}

    try:
        with DB_PATH.open("r", encoding="utf-8") as file:
            data = json.load(file)

        if not isinstance(data, dict):
            raise ValueError("Database root must be an object")

        return data

    except (json.JSONDecodeError, ValueError) as error:
        raise RuntimeError("Override database is invalid") from error


def saveDatabase(data: dict[str, list[Any]]) -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)

    tempPath = DB_PATH.with_suffix(".tmp")

    with tempPath.open("w", encoding="utf-8") as file:
        json.dump(data, file, indent=4, ensure_ascii=False)

    tempPath.replace(DB_PATH)


def pushTrack(
    trackId: str,
    lyricsId: str,
    provider: str,
    instrumental: bool,
) -> None:
    data = loadDatabase()

    data[trackId] = [
        lyricsId,
        provider,
        instrumental,
    ]

    saveDatabase(data)


@app.get("/")
async def root():
    # The static client lives beside this API module in services/public.
    # Resolving from the repository root made the endpoint fail with a
    # FileNotFoundError after the client was moved into the services folder.
    return FileResponse(Path(__file__).resolve().parent / "public" / "index.html")


@app.post("/overrides")
async def createOverride(override: TrackOverride):
    async with dbLock:
        try:
            data = loadDatabase()

            data[override.trackId] = [
                override.lyricsId,
                override.provider,
                override.instrumental,
            ]

            saveDatabase(data)

        except RuntimeError as error:
            raise HTTPException(
                status_code=500,
                detail=str(error),
            ) from error

    return {
        "success": True,
        "trackId": override.trackId,
        "override": data[override.trackId],
    }


@app.get("/overrides/{trackId}")
async def getOverride(trackId: str):
    async with dbLock:
        try:
            data = loadDatabase()
        except RuntimeError as error:
            raise HTTPException(
                status_code=500,
                detail=str(error),
            ) from error

    override = data.get(trackId)

    if override is None:
        raise HTTPException(
            status_code=404,
            detail="No override found for this track",
        )

    if not isinstance(override, list) or len(override) != 3:
        raise HTTPException(
            status_code=500,
            detail="Invalid override record",
        )

    lyricsId, provider, instrumental = override

    return {
        "trackId": trackId,
        "lyricsId": lyricsId,
        "provider": provider,
        "instrumental": bool(instrumental),
    }


def run() -> None:
    """Start the local API server when this module is run as a script."""
    uvicorn.run(
        app,
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8000")),
    )


if __name__ == "__main__":
    run()
