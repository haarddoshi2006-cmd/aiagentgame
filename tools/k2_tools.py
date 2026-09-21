# tools/k2_tools.py — standalone K2 client (not used by dev-sim coding agent).
import os
from openai import OpenAI

K2_MODEL = "MBZUAI-IFM/K2-Think-v2"

client = OpenAI(
    api_key=os.getenv("K2_API_KEY"),
    base_url="https://api.k2think.ai/v1",
)


def k2_chat(messages: list, stream: bool = False):
    return client.chat.completions.create(
        model=K2_MODEL,
        messages=messages,
        stream=stream,
    )
