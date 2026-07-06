import os
import sys
import types
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import utils


def _install_heavy_import_stubs():
    """Stub third-party deps so model_downloader imports in a minimal test env."""
    if "psutil" not in sys.modules:
        psutil = types.ModuleType("psutil")
        common = types.ModuleType("psutil._common")
        common.bytes2human = lambda n: str(n)
        psutil._common = common
        sys.modules["psutil"] = psutil
        sys.modules["psutil._common"] = common
    if "requests" not in sys.modules:
        sys.modules["requests"] = types.ModuleType("requests")
    if "huggingface_hub" not in sys.modules:
        hub = types.ModuleType("huggingface_hub")
        hub.HfFileSystem = object
        hub.hf_hub_url = lambda **kwargs: ""
        hub.model_info = lambda *args, **kwargs: None
        sys.modules["huggingface_hub"] = hub


class TestHFChunkHttpOk(unittest.TestCase):
    def test_fresh_expect_200_only(self):
        self.assertTrue(utils.hf_chunk_http_ok(200, 0))
        self.assertFalse(utils.hf_chunk_http_ok(206, 0))

    def test_resume_accepts_200_and_206(self):
        self.assertTrue(utils.hf_chunk_http_ok(200, 1))
        self.assertTrue(utils.hf_chunk_http_ok(206, 1))
        self.assertFalse(utils.hf_chunk_http_ok(404, 1))


class TestMoveToDesiredPositionFlatStructure(unittest.TestCase):
    """Reactor (faceswap/facerestore) models must land as a single flat *file*
    named "<owner>---<repo>---<file>", not a directory containing that file.
    Regression test for the reactor node failing with
    "model_file ...inswapper_128.onnx should be a file".
    """

    def _make_downloader(self, save_path, repo_id):
        _install_heavy_import_stubs()
        import model_downloader

        dl = model_downloader.HFPlaygroundDownloader.__new__(
            model_downloader.HFPlaygroundDownloader
        )
        dl.repo_id = repo_id
        dl.save_path = save_path
        dl.save_path_tmp = os.path.join(save_path, "tmp")
        os.makedirs(dl.save_path_tmp, exist_ok=True)
        return dl

    def test_insightface_model_becomes_flat_file(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            save_path = os.path.join(tmp, "insightface")
            os.makedirs(save_path)
            repo_id = "Aitrepreneur/insightface/inswapper_128.onnx"
            dl = self._make_downloader(save_path, repo_id)
            # Simulate the downloaded file sitting in the tmp staging dir.
            with open(os.path.join(dl.save_path_tmp, "inswapper_128.onnx"), "wb") as f:
                f.write(b"weights")

            dl.move_to_desired_position()

            flat = os.path.join(
                save_path, "Aitrepreneur---insightface---inswapper_128.onnx"
            )
            self.assertTrue(os.path.isfile(flat), "flat name must be a file")
            self.assertFalse(os.path.exists(dl.save_path_tmp))

    def test_stale_directory_is_replaced_by_file(self):
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            save_path = os.path.join(tmp, "insightface")
            os.makedirs(save_path)
            repo_id = "Aitrepreneur/insightface/inswapper_128.onnx"
            flat = os.path.join(
                save_path, "Aitrepreneur---insightface---inswapper_128.onnx"
            )
            # An earlier broken download left the flat name as a *directory*.
            os.makedirs(flat)
            with open(os.path.join(flat, "inswapper_128.onnx"), "wb") as f:
                f.write(b"stale")

            dl = self._make_downloader(save_path, repo_id)
            with open(os.path.join(dl.save_path_tmp, "inswapper_128.onnx"), "wb") as f:
                f.write(b"weights")

            dl.move_to_desired_position()

            self.assertTrue(os.path.isfile(flat))
            with open(flat, "rb") as f:
                self.assertEqual(f.read(), b"weights")


if __name__ == "__main__":
    unittest.main()
