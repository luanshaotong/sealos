FROM python:3.12.13-slim-bookworm

RUN apt-get update \
    && apt-get upgrade -y \
    && apt-get install -y --no-install-recommends openssh-client \
    && python -m pip install --no-cache-dir \
        flask \
        apscheduler \
        PyYAML \
        requests \
        docker \
        aiohttp \
        pydantic \
        kubernetes \
        grpcio \
        grpcio-tools \
    && rm -rf /var/lib/apt/lists/*
