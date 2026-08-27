import importlib
import os
import queue
import sys
import tempfile
import threading
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))


def _register(name: str, **attrs) -> types.ModuleType:
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module
    parent, _, child = name.rpartition(".")
    if parent:
        setattr(sys.modules[parent], child, module)
    return module


class _StubTqdm:
    """Stand-in for huggingface_hub's progress bar, matching the part we subclass."""

    def __init__(self, *args, **kwargs):
        self.n = 0

    def update(self, n=1):
        self.n += n

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _install_heavy_import_stubs():
    """Stub third-party deps so model_downloader imports in a minimal test env.

    An installed package always wins, so where the service's dependencies are
    present these tests run against the real huggingface_hub progress bar.
    """
    if not _importable("psutil"):
        _register("psutil")
        _register("psutil._common", bytes2human=str)
    if not _importable("requests"):
        _register("requests")
        _register("requests.exceptions", RequestException=OSError)
    if not _importable("httpx"):
        _register("httpx", HTTPError=OSError)
    if not _importable("huggingface_hub"):
        _register(
            "huggingface_hub",
            HfFileSystem=object,
            hf_hub_url=lambda **kwargs: "",
            hf_hub_download=lambda **kwargs: "",
            model_info=lambda *args, **kwargs: None,
        )
        _register("huggingface_hub.errors", HfHubHTTPError=OSError)
        _register("huggingface_hub.utils", tqdm=_StubTqdm)


def _importable(name: str) -> bool:
    try:
        importlib.import_module(name)
        return True
    except ImportError:
        return False


def _import_model_downloader():
    _install_heavy_import_stubs()
    import model_downloader

    return model_downloader


def _bare_downloader(md, **attrs):
    """A downloader with only the fields under test set.

    `__init__` builds an `HfFileSystem`, which needs network config and is stubbed
    out in a minimal test env, so these tests never call it.
    """
    dl = md.HFPlaygroundDownloader.__new__(md.HFPlaygroundDownloader)
    dl.download_stop = False
    dl.download_size = 0
    dl.error = None
    dl.hf_token = None
    dl.thread_lock = threading.Lock()
    for key, value in attrs.items():
        setattr(dl, key, value)
    return dl


class TestHubDownloadCall(unittest.TestCase):
    """The transfer must be handed to huggingface_hub by repo + filename.

    Passing a resolve URL instead would pin every file to the single-stream HTTP
    bridge; repo + filename is what lets hub use the local Xet client.
    """

    def _capture_download_kwargs(self, repo_id, relpath, token):
        md = _import_model_downloader()
        calls = []
        dl = _bare_downloader(
            md,
            repo_id=repo_id,
            save_path_tmp=os.path.join("save", "abcd1234_tmp"),
            hf_token=token,
            progress_reporter=object(),
        )
        item = md.HFDownloadItem(relpath, 10, "https://hf.co/resolve/url", "unused")
        with mock.patch.object(
            md, "hf_hub_download", lambda **kwargs: calls.append(kwargs)
        ):
            dl.download_one_file(item)
        self.assertEqual(len(calls), 1)
        return calls[0]

    def test_repo_is_trimmed_and_file_staged_in_tmp(self):
        kwargs = self._capture_download_kwargs(
            "Aitrepreneur/insightface/inswapper_128.onnx",
            "inswapper_128.onnx",
            "hf_token_value",
        )
        self.assertEqual(kwargs["repo_id"], "Aitrepreneur/insightface")
        self.assertEqual(kwargs["filename"], "inswapper_128.onnx")
        self.assertEqual(kwargs["local_dir"], os.path.join("save", "abcd1234_tmp"))
        self.assertEqual(kwargs["token"], "hf_token_value")

    def test_no_resolve_url_is_passed(self):
        kwargs = self._capture_download_kwargs("owner/repo", "model.safetensors", None)
        self.assertNotIn("url", kwargs)
        for value in kwargs.values():
            self.assertNotIn("resolve", str(value))

    def test_windows_relpath_becomes_a_hub_path(self):
        kwargs = self._capture_download_kwargs(
            "owner/repo", "split_files\\vae\\ae.safetensors", None
        )
        self.assertEqual(kwargs["filename"], "split_files/vae/ae.safetensors")


class TestProgressReporter(unittest.TestCase):
    def _reporter(self, dl, md, name):
        return md._make_progress_reporter(dl)(
            name=name, total=100, initial=0, desc="model.safetensors"
        )

    def test_bytes_are_counted_for_the_progress_feed(self):
        md = _import_model_downloader()
        dl = _bare_downloader(md)
        bar = self._reporter(dl, md, "huggingface_hub.http_get")
        bar.update(10)
        bar.update(7)
        self.assertEqual(dl.download_size, 17)

    def test_stop_aborts_the_http_transfer(self):
        md = _import_model_downloader()
        dl = _bare_downloader(md)
        bar = self._reporter(dl, md, "huggingface_hub.http_get")
        bar.update(10)
        dl.download_stop = True
        with self.assertRaises(md._DownloadStopped):
            bar.update(5)

    def test_stop_does_not_raise_on_the_xet_transfer(self):
        """hf_xet invokes the callback from Rust, which swallows the exception and
        finishes the file regardless; `stop_download` aborts the session instead."""
        md = _import_model_downloader()
        dl = _bare_downloader(md)
        bar = self._reporter(dl, md, md._XET_PROGRESS_NAME)
        dl.download_stop = True
        bar.update(5)
        self.assertEqual(dl.download_size, 5)


class TestStopDownload(unittest.TestCase):
    def test_user_stop_keeps_staging_dir_and_reports_no_error(self):
        md = _import_model_downloader()
        with tempfile.TemporaryDirectory() as tmp:
            staging = os.path.join(tmp, "abcd1234_tmp")
            os.makedirs(staging)
            dl = _bare_downloader(
                md,
                repo_id="owner/repo",
                save_path_tmp=staging,
                progress_reporter=object(),
                file_queue=queue.Queue(),
            )
            dl.file_queue.put(
                md.HFDownloadItem("model.safetensors", 10, "url", "unused")
            )

            def stop_midway(**_kwargs):
                dl.download_stop = True
                raise md._DownloadStopped()

            with mock.patch.object(md, "hf_hub_download", stop_midway):
                dl.download_model_file()

            self.assertIsNone(dl.error)
            self.assertTrue(os.path.isdir(staging))

    def test_stop_download_survives_a_build_without_xet(self):
        md = _import_model_downloader()
        dl = _bare_downloader(md)
        with mock.patch.dict(sys.modules, {"huggingface_hub.utils._xet": None}):
            dl.stop_download()
        self.assertTrue(dl.download_stop)

    def test_persistent_failure_is_reported_as_a_download_error(self):
        md = _import_model_downloader()
        dl = _bare_downloader(
            md,
            repo_id="owner/repo",
            save_path_tmp="staging",
            progress_reporter=object(),
            file_queue=queue.Queue(),
        )
        dl.file_queue.put(md.HFDownloadItem("model.safetensors", 10, "url", "unused"))

        def always_fail(**_kwargs):
            raise OSError("connection reset")

        with (
            mock.patch.object(md, "hf_hub_download", always_fail),
            mock.patch("time.sleep"),
        ):
            dl.download_model_file()

        self.assertIsInstance(dl.error, md.DownloadException)


class TestBuildQueue(unittest.TestCase):
    """Resume is per file: hub discards its own partial files, so a short file is
    re-fetched whole and must not be counted as already downloaded."""

    def _queue_for(self, staged, expected_size):
        md = _import_model_downloader()
        with tempfile.TemporaryDirectory() as tmp:
            dl = _bare_downloader(md, save_path_tmp=tmp, file_queue=queue.Queue())
            if staged is not None:
                with open(os.path.join(tmp, "model.safetensors"), "wb") as f:
                    f.write(staged)
            dl.build_queue([md.HFFileItem("model.safetensors", expected_size, "url")])
            return dl

    def test_complete_file_is_skipped_and_counted(self):
        dl = self._queue_for(b"x" * 10, 10)
        self.assertTrue(dl.file_queue.empty())
        self.assertEqual(dl.download_size, 10)

    def test_partial_file_is_queued_and_not_counted(self):
        dl = self._queue_for(b"x" * 4, 10)
        self.assertEqual(dl.file_queue.qsize(), 1)
        self.assertEqual(dl.download_size, 0)

    def test_missing_file_is_queued(self):
        dl = self._queue_for(None, 10)
        self.assertEqual(dl.file_queue.qsize(), 1)
        self.assertEqual(dl.download_size, 0)


class TestMoveToDesiredPositionFlatStructure(unittest.TestCase):
    """Reactor (faceswap/facerestore) models must land as a single flat *file*
    named "<owner>---<repo>---<file>", not a directory containing that file.
    Regression test for the reactor node failing with
    "model_file ...inswapper_128.onnx should be a file".
    """

    def _make_downloader(self, save_path, repo_id):
        md = _import_model_downloader()
        dl = md.HFPlaygroundDownloader.__new__(md.HFPlaygroundDownloader)
        dl.repo_id = repo_id
        dl.save_path = save_path
        dl.save_path_tmp = os.path.join(save_path, "tmp")
        os.makedirs(dl.save_path_tmp, exist_ok=True)
        return dl

    def test_insightface_model_becomes_flat_file(self):
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

    def test_hub_staging_cache_is_not_moved_into_the_model_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            save_path = os.path.join(tmp, "ggufLLM")
            os.makedirs(save_path)
            dl = self._make_downloader(save_path, "owner/repo")
            with open(os.path.join(dl.save_path_tmp, "model.gguf"), "wb") as f:
                f.write(b"weights")
            hub_cache = os.path.join(dl.save_path_tmp, ".cache", "huggingface")
            os.makedirs(hub_cache)
            with open(os.path.join(hub_cache, "CACHEDIR.TAG"), "wb") as f:
                f.write(b"tag")

            dl.move_to_desired_position()

            model_dir = os.path.join(save_path, "owner---repo")
            self.assertTrue(os.path.isfile(os.path.join(model_dir, "model.gguf")))
            self.assertFalse(os.path.exists(os.path.join(model_dir, ".cache")))


if __name__ == "__main__":
    unittest.main()
