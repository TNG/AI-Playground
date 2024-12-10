import requests


url = "http://127.0.0.1:59999/api/llm/chat"
params = {
  "prompt": [{"question": "Who is the president of the United States?" }],
  "device": "",
  "enable_rag": False,
  "model_repo_id": "codellama-7b.Q4_0.gguf",
  "backend_type": "",
}
response = requests.post(url, json=params, stream=True)
# Check if the response status code is 200 (OK)
response.raise_for_status()
e = 1
# Iterate over the response lines
for line in response.iter_lines():
    e += 1
    if line:
        # Decode the line (assuming UTF-8 encoding)
        decoded_line = line.decode('utf-8')

        # SSE events typically start with "data: "
        if decoded_line.startswith("data: "):
            # Extract the data part
            data = decoded_line[len("data: "):]
            print(data)  # Process the data as needed