from typing import Dict, List
from llm_interface import LLMInterface
from llama_cpp import CreateChatCompletionStreamResponse, Iterator, Llama
from llm_params import LLMParams

class LlamaCpp(LLMInterface):
    def __init__(self):
        self._model = None
        self.stop_generate = False

    def load_model(self,  params: LLMParams, model_path: str = r"C:\Users\InnoHacker\Downloads\meta-llama-3.1-8b-instruct.Q5_K_M.gguf", n_gpu_layers: int = -1, context_length: int = 16000):
        self._model = Llama(
            model_path=model_path,
            n_gpu_layers=n_gpu_layers,
            n_ctx=context_length,
        )

    def create_chat_completion(self, messages: List[Dict[str, str]]):
        completion: Iterator[CreateChatCompletionStreamResponse] = self._model.create_chat_completion(
            messages = messages,
            stream = True,
        )
        return completion

    def unload_model(self):
        pass

    def get_backend_type(self):
        return "llama_cpp"