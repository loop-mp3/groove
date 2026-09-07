from typing import Annotated

from fastapi import FastAPI, Header
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from fastapi.responses import FileResponse, HTMLResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
import uvicorn
import os
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(
    title="Groove",
    version="1.0.0",
)

def write_announcement(content):
    try:
        os.remove("announcement.txt")
    except FileNotFoundError:
        with open("announcement.txt", "x") as f:
            f.write(content)
        return {"message": "Announcement created successfully"}

@app.get("/api/v1/health")
def health():
    return {
        "status": "ok",
        "service": "groove",
        "version": "1",
    }

@app.post("/api/announcement/create")
def create_announcement(Authorisation: Annotated[str | None, Header()] = None, content: Annotated[str | None, Header()] = None ):
    if Authorisation != os.getenv("ADMIN_PASSWORD"):
        raise HTTPException(status_code=401, detail="Unauthorized")
    else:
        res = write_announcement(content)
        return res

@app.get("/api/announcement")
def get_announcement():
    try:
        with open("announcement.txt", "r") as f:
            content = f.read()
        return {"content": content}
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Announcement not found")

def run_server(host="127.0.0.1", port=8000, cleanup_interval=60):
    try:
        uvicorn.run(app, host=host, port=port)
    except Exception as e:
        print(f"Error running server: {e}")
        
@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    if exc.status_code == 404:
        return JSONResponse(
            status_code=404,
            content={
                "error": "Not found File must have expired dummy!"
            }
        )

    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": exc.detail
        }
    )


if __name__ == "__main__":
    run_server()    