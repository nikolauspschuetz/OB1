FROM python:3.13-alpine
WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY . /app/integrations/slack_bot
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app
RUN adduser -D -u 1000 bot
USER bot
ENTRYPOINT ["python3", "-u", "-m", "integrations.slack_bot"]
