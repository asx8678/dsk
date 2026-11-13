"""Tests for dsk: stdlib unittest, a scripted API server, temp git repositories.

Run from the project root:  python3 -m unittest discover -s tests
The scripted server covers what a real API cannot produce on demand (a 402, a cut-off reply, exact request
bytes); tests/live.py runs real tasks against the real providers.
"""
import ast, importlib.util, json, os, shutil, subprocess, sys, tempfile, threading, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest import mock

DSK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skill", "scripts", "dsk.py")
spec = importlib.util.spec_from_file_location("dsk", DSK)
dsk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dsk)


def script(body):
    """A reply that calls run_code with this script."""
    return {"code": body}


def common(a, b):
    n = 0
    while n < min(len(a), len(b)) and a[n] == b[n]:
        n += 1
    return n


class FakeAPI:
    """Records every request and plays scripted replies.

    A reply is {"code": ...} for one run_code call, plain text for a reply without a call, or a dict with
    "status", "arguments" (raw call arguments), "calls" (several calls), "finish", "blank" (keep-alive lines),
    "usage" or "message" (extra message fields). Like a real API it rejects a malformed message list, and it
    models cache hits as the longest prefix shared with an earlier request.
    """

    def __init__(self):
        api = self
        self.requests, self.replies, self.seen = [], [], []
        self.search_results, self.pages, self.between_turns = [], {}, {}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                raw = self.rfile.read(int(self.headers["Content-Length"]))
                api.requests.append({"path": self.path, "raw": raw, "key": self.headers["Authorization"]})
                status, payload, blank = api.answer(self.path, json.loads(raw))
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b"\n" * blank + json.dumps(payload).encode())

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, args=(0.01,), daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def chats(self):
        return [r for r in self.requests if r["path"].endswith("/chat/completions")]

    def bodies(self):
        return [json.loads(r["raw"]) for r in self.chats()]

    @staticmethod
    def invalid(messages):
        """Why a real API would reject this message list, or None."""
        if [m["role"] for m in messages[:2]] != ["system", "user"]:
            return "the list must open with a system and a user message"
        last, owed = "user", []
        for m in messages[2:]:
            role = m["role"]
            if role == "tool":
                if not owed or owed.pop(0) != m.get("tool_call_id"):
                    return "a tool message does not answer the next open call"
            elif owed:
                return "a tool call was left unanswered"
            elif role == last:
                return f"two {role} messages in a row"
            elif role == "assistant":
                owed = [c["id"] for c in m.get("tool_calls", [])]
            last = role
        return "the list must end with a user or tool message" if owed or last == "assistant" else None

    def answer(self, path, body):
        if path.endswith("/tools/search"):
            return 200, {"results": self.search_results[:body.get("count", 10)]}, 0
        if path.endswith("/tools/fetch"):
            page = self.pages.get(body["url"])
            return (200, page, 0) if page else (404, {"error": {"message": "no usable content"}}, 0)
        self.between_turns.pop(len(self.chats()), lambda: None)()
        problem = self.invalid(body["messages"])
        if problem:
            return 400, {"error": {"message": problem}}, 0
        reply = self.replies.pop(0) if self.replies else {"status": 500, "error": "no scripted reply left"}
        reply = {"content": reply} if isinstance(reply, str) else reply
        if reply.get("status", 200) != 200:
            return reply["status"], {"error": {"message": reply.get("error", "scripted failure")}}, 0
        calls = reply.get("calls") or []
        if "code" in reply or "arguments" in reply:
            calls = [{"arguments": reply.get("arguments", json.dumps({"code": reply.get("code")}))}]
        message = {"role": "assistant", "content": reply.get("content", ""), **reply.get("message", {})}
        if calls:
            message["tool_calls"] = [{"index": i, "id": f"call_{len(self.seen)}_{i}", "type": "function", "function": {
                "name": c.get("name", "run_code"), "arguments": c["arguments"]}} for i, c in enumerate(calls)]
        wire = json.dumps(body["messages"], ensure_ascii=False)
        shared = max((common(wire, old) for old in self.seen), default=0)
        self.seen.append(wire)
        usage = {"prompt_tokens": len(wire) // 4, "completion_tokens": len(json.dumps(message)) // 4,
                 "prompt_cache_hit_tokens": shared // 4, "prompt_cache_miss_tokens": len(wire) // 4 - shared // 4}
        choice = {"index": 0, "finish_reason": reply.get("finish", "tool_calls" if calls else "stop"), "message": message}
        payload = {"id": "x", "object": "chat.completion", "choices": [choice], "usage": reply.get("usage", usage)}
        return 200, payload, reply.get("blank", 0)


class Case(unittest.TestCase):
    """A temp state and config directory, a fake API with profiles `a` and `b`, and helpers to drive dsk."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.api = FakeAPI()
        self.addCleanup(self.api.close)
        self.env = {**os.environ, "XDG_STATE_HOME": f"{self.tmp}/state", "XDG_CONFIG_HOME": f"{self.tmp}/config",
                    "KEY_A": "sk-fake-a", "KEY_B": "sk-fake-b", "KEY_S": "sk-fake-search",
                    "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1", "CLAUDE_CODE_SESSION_ID": ""}
        self.config = {
            "route": ["a", "b"], "backoff": [0, 0],
            "profiles": {"a": {"base_url": self.api.url + "/a", "key_env": "KEY_A", "model": "model-a"},
                         "b": {"base_url": self.api.url + "/b", "key_env": "KEY_B", "model": "model-b"}},
            "search": {"base_url": self.api.url, "key_env": "KEY_S"},
        }
        self.write_config()
        for patch in (mock.patch.dict(os.environ, self.env), mock.patch.object(dsk, "STATE", f"{self.tmp}/state/dsk")):
            patch.start()
            self.addCleanup(patch.stop)

    def write_config(self):
        os.makedirs(f"{self.tmp}/config/dsk", exist_ok=True)
        with open(f"{self.tmp}/config/dsk/config.json", "w") as f:
            json.dump(self.config, f)

    def session(self, **head):
        s = dsk.Session()
        s.add("head", id=s.id, **{"effort": "off", "route": ["a", "b"], **head})
        s.add("series", why="start", profile="a")
        s.add("msg", turn=0, m={"role": "system", "content": dsk.SYSTEM})
        s.add("msg", turn=0, m={"role": "user", "content": "task"})
        return s


class Wire(Case):
    def test_body_has_fixed_order_one_static_tool_and_nothing_volatile(self):
        profile, msgs = {"model": "m", "extra": {}}, [{"role": "user", "content": "héllo"}]
        body = dsk.request_body(profile, "off", msgs)
        self.assertEqual(body, dsk.request_body(dict(profile), "off", list(msgs)))
        self.assertEqual(body, '{"model":"m","messages":[{"role":"user","content":"héllo"}],"tools":' + dsk.dumps(dsk.TOOLS)
                         + ',"max_tokens":16000,"stream":false,"tool_choice":"required","thinking":{"type":"disabled"},'
                           '"reasoning_effort":"none","temperature":0}')
        high = json.loads(dsk.request_body(profile, "high", msgs))
        self.assertEqual((high["thinking"], high["reasoning_effort"], high["max_tokens"], high["tool_choice"]),
                         ({"type": "enabled"}, "high", 64000, "auto"))
        for absent in ("temperature", "top_p", "user_id"):
            self.assertNotIn(absent, high)
        self.assertEqual([(t["function"]["name"], list(t["function"]["parameters"]["properties"])) for t in high["tools"]],
                         [("run_code", ["code"])])

    def test_extra_overrides_and_null_removes(self):
        profile = {"model": "m", "extra": {"thinking": None, "enable_thinking": False, "user_id": "dsk"}}
        body = json.loads(dsk.request_body(profile, "off", []))
        self.assertNotIn("thinking", body)
        self.assertEqual((body["enable_thinking"], body["user_id"]), (False, "dsk"))

    def test_system_prompt_is_static(self):
        today = __import__("datetime").date.today()
        for volatile in (os.getcwd(), os.path.expanduser("~"), str(today.year), self.tmp):
            self.assertNotIn(volatile, dsk.SYSTEM)
        for module in dsk.IMPORTS:
            self.assertIn(module, dsk.SYSTEM)

    def test_blank_keepalive_lines_are_tolerated(self):
        self.api.replies = [{"content": "hello", "blank": 5}]
        self.assertEqual(dsk.chat(self.session(), dsk.config()), ({"role": "assistant", "content": "hello"}, "stop"))

    def test_reply_is_kept_exactly_as_it_will_be_replayed(self):
        self.api.replies = [{"arguments": '{"code":  "print(\\"é\\")" }'}]
        reply, finish = dsk.chat(self.session(), dsk.config())
        self.assertEqual((finish, list(reply)), ("tool_calls", ["role", "content", "tool_calls"]))
        self.assertEqual(reply["tool_calls"], [{"id": "call_0_0", "type": "function", "function": {
            "name": "run_code", "arguments": '{"code":  "print(\\"é\\")" }'}}])

    def test_reasoning_is_replayed_only_when_thinking_is_on(self):
        for effort, kept in (("high", True), ("off", False)):
            self.api.replies = [{"code": "print(1)", "message": {"reasoning_content": "let me think"}}]
            reply, _ = dsk.chat(self.session(effort=effort), dsk.config())
            self.assertEqual(reply.get("reasoning_content"), "let me think" if kept else None)
        self.api.replies = [{"code": "print(1)", "message": {"reasoning": "gateway spelling"}}]
        self.assertEqual(dsk.chat(self.session(effort="low"), dsk.config())[0]["reasoning_content"], "gateway spelling")

    def test_retry_sends_identical_bytes(self):
        self.api.replies = [{"status": 503}, {"status": 429}, "ok"]
        s = self.session()
        self.assertEqual(dsk.chat(s, dsk.config())[0]["content"], "ok")
        raws = [r["raw"] for r in self.api.chats()]
        self.assertEqual(len(raws), 3)
        self.assertEqual(len(set(raws)), 1)
        self.assertEqual(len(s.of("req")), 1)

    def test_interrupted_generation_is_retried(self):
        self.api.replies = [{"content": "half", "finish": "aborted"}, "whole"]
        self.assertEqual(dsk.chat(self.session(), dsk.config())[0]["content"], "whole")

    def test_a_limit_reported_as_400_is_retried_like_a_429(self):
        limit = {"status": 400, "error": "[code=tier_limit_exceeded] membership concurrency limit exceeded: 11/10"}
        self.api.replies = [limit, limit, "after the limit cleared"]
        self.assertEqual(dsk.chat(self.session(route=["a"]), dsk.config())[0]["content"], "after the limit cleared")
        self.api.replies = [limit] * 3 + ["from b"]
        s = self.session()
        self.assertEqual(dsk.chat(s, dsk.config())[0]["content"], "from b")
        self.assertEqual(s.profile, "b")

    def test_client_errors_are_not_retried(self):
        self.api.replies = [{"status": 400, "error": "bad request body"}]
        with self.assertRaisesRegex(dsk.Fail, "a: HTTP 400 .*bad request body"):
            dsk.chat(self.session(route=["a"]), dsk.config())
        self.assertEqual(len(self.api.chats()), 1)

    def test_failover_on_402_starts_a_new_series_with_the_same_messages(self):
        self.api.replies = [{"status": 402}, "from b"]
        s = self.session()
        self.assertEqual(dsk.chat(s, dsk.config())[0]["content"], "from b")
        first, second = self.api.chats()
        self.assertTrue(first["path"].startswith("/a/") and second["path"].startswith("/b/"))
        self.assertEqual((first["key"], second["key"]), ("Bearer sk-fake-a", "Bearer sk-fake-b"))
        a, b = self.api.bodies()
        self.assertEqual((a["model"], b["model"]), ("model-a", "model-b"))
        self.assertEqual(a["messages"], b["messages"])
        self.assertEqual([(r["why"], r["profile"]) for r in s.of("series")], [("start", "a"), ("failover", "b")])
        self.assertEqual(s.profile, "b")

    def test_failover_after_repeated_5xx_and_error_when_route_is_exhausted(self):
        self.api.replies = [{"status": 500}] * 3 + [{"status": 503}] * 3
        with self.assertRaisesRegex(dsk.Fail, "b: HTTP 503"):
            dsk.chat(self.session(), dsk.config())
        self.assertEqual(len(self.api.chats()), 6)

    def test_network_failure_is_retried_then_fails_over_or_is_reported(self):
        self.config["profiles"]["a"]["base_url"] = "http://127.0.0.1:1"  # nothing listens there
        self.write_config()
        self.api.replies = ["from b"]
        s = self.session()
        self.assertEqual(dsk.chat(s, dsk.config())[0]["content"], "from b")
        self.assertEqual([(r["why"], r.get("status")) for r in s.of("series")], [("start", None), ("failover", 0)])
        with self.assertRaisesRegex(dsk.Fail, "a: HTTP 0 URLError"):
            dsk.chat(self.session(route=["a"]), dsk.config())

    def test_missing_key_is_an_error_and_never_sent(self):
        with mock.patch.dict(os.environ, {"KEY_A": ""}):
            with self.assertRaisesRegex(dsk.Fail, "KEY_A is not set"):
                dsk.chat(self.session(), dsk.config())
        self.assertEqual(self.api.requests, [])

    def test_key_falls_back_to_the_env_file_and_stays_out_of_the_environment(self):
        with open(f"{self.tmp}/config/dsk/env", "w") as f:
            f.write("# keys\nexport KEY_A='sk-from-file' # a comment\nKEY_B=\"sk-b-file\"\n")
        self.api.replies = ["one", "two"]
        with mock.patch.dict(os.environ, {"KEY_A": "", "KEY_B": ""}):
            dsk.chat(self.session(), dsk.config())
            self.assertEqual(os.environ["KEY_A"], "")
            self.assertNotIn("sk-from-file", json.dumps(dsk.clean_env(dsk.config(), self.tmp)))
        dsk.chat(self.session(), dsk.config())
        self.assertEqual([r["key"] for r in self.api.requests], ["Bearer sk-from-file", "Bearer sk-fake-a"])

    def test_full_profile_is_skipped_and_the_last_one_waits_for_a_slot(self):
        def release():
            for handle in dsk.slots.values():
                handle.close()
            dsk.slots.clear()
        self.addCleanup(release)
        self.config["profiles"]["a"]["max_sessions"] = 1
        self.write_config()
        os.makedirs(f"{self.tmp}/state/dsk/slots")
        other = dsk.flock(f"{self.tmp}/state/dsk/slots/a.0", "")  # another run holds a's only slot
        self.api.replies = ["from b", "from a"]
        s = self.session()
        self.assertEqual(dsk.chat(s, dsk.config())[0]["content"], "from b")
        self.assertEqual([(r["why"], r.get("status")) for r in s.of("series")], [("start", None), ("failover", "full")])
        self.assertEqual([r["path"] for r in self.api.chats()], ["/b/chat/completions"])
        threading.Timer(0.2, other.close).start()
        with mock.patch.object(dsk, "SLOT_POLL", 0.05):
            self.assertEqual(dsk.chat(self.session(route=["a"]), dsk.config())[0]["content"], "from a")
        with self.assertRaises(dsk.Fail):  # this process now holds the slot
            dsk.flock(f"{self.tmp}/state/dsk/slots/a.0", "")

    def test_series_guard_rejects_a_rewritten_prefix(self):
        self.api.replies = ["one", "two"]
        s, cfg = self.session(), dsk.config()
        s.add("msg", turn=1, m=dsk.chat(s, cfg)[0])
        s.add("msg", turn=1, m={"role": "user", "content": "result"})
        dsk.chat(s, cfg)
        s.recs[3]["m"]["content"] = "task, edited after it was sent"
        with self.assertRaisesRegex(dsk.Fail, "does not extend"):
            dsk.chat(s, cfg)
        self.assertEqual(len(self.api.chats()), 2)

    def test_usage_is_logged_with_either_cache_field(self):
        self.api.replies = [
            {"content": "x", "usage": {"prompt_tokens": 100, "completion_tokens": 7, "prompt_cache_hit_tokens": 90}},
            {"content": "x", "usage": {"prompt_tokens": 100, "completion_tokens": 7,
                                       "prompt_tokens_details": {"cached_tokens": 80}}},
            {"content": "x", "usage": {"prompt_tokens": 100, "completion_tokens": 7}},
        ]
        s, cfg = self.session(), dsk.config()
        for _ in range(3):
            dsk.chat(s, cfg)
        self.assertEqual([(u["prompt"], u["hit"], u["out"]) for u in s.of("usage")],
                         [(100, 90, 7), (100, 80, 7), (100, None, 7)])

    def test_log_reloads_from_disk_and_keys_stay_out_of_it(self):
        self.api.replies = ["x"]
        s = self.session()
        dsk.chat(s, dsk.config())
        self.assertEqual(dsk.Session(s.id).recs, s.recs)
        with open(s.path) as f:
            self.assertNotIn("sk-fake", f.read())


class Cli(Case):
    """Drives the real command line against the fake API."""

    def repo(self, files):
        path = tempfile.mkdtemp(dir=self.tmp)
        self.put(path, files)
        for args in (["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]):
            subprocess.run(["git", *args], cwd=path, env=self.env, check=True, capture_output=True)
        return path

    def put(self, root, files):
        for name, text in files.items():
            os.makedirs(os.path.dirname(os.path.join(root, name)), exist_ok=True)
            with open(os.path.join(root, name), "w") as f:
                f.write(text)

    def cat(self, *parts):
        with open(os.path.join(*parts)) as f:
            return f.read()

    def git(self, repo, *args):
        return subprocess.run(["git", *args], cwd=repo, env=self.env, capture_output=True, text=True).stdout

    def dsk(self, *args, cwd=None, stdin=None):
        done = subprocess.run([sys.executable, DSK, *args], cwd=cwd or self.tmp, env=self.env, input=stdin,
                              capture_output=True, text=True, timeout=120)
        return done.returncode, done.stdout, done.stderr

    def run_ok(self, *args, cwd=None, code=0):
        got, out, err = self.dsk("run", *args, cwd=cwd)
        self.assertEqual(got, code, out + err)
        return out, out.split()[1]

    def back(self, n):
        """The message that carried the result of turn n."""
        return self.api.bodies()[n]["messages"][-1]["content"]

    def output(self, sid, turn):
        return self.cat(self.tmp, "state/dsk", sid, "out", str(turn))


class Plugin(Cli):
    """The Claude Code plugin's options: stored by `configure --hook`, read by `config` and `secret`."""

    def setUp(self):
        super().setUp()
        os.remove(f"{self.tmp}/config/dsk/config.json")  # nothing but the plugin's options sets these runs up
        self.env.update(DEEPSEEK_API_KEY="", DSK_CUSTOM_API_KEY="")
        self.data = f"{self.tmp}/data/dsk-acme"  # Claude Code names a plugin's data folder after its id

    def hook(self, *flags, **options):
        env = {f"CLAUDE_PLUGIN_OPTION_{name.upper()}": value for name, value in options.items()}
        done = subprocess.run([sys.executable, DSK, "configure", "--hook", "--data", self.data, *flags], env={**self.env, **env},
                              input='{"hook_event_name": "SessionStart"}', capture_output=True, text=True, timeout=60)
        return done.returncode, done.stdout

    def test_hook_stores_the_options_for_their_owner_alone_and_points_at_them(self):
        self.assertEqual(self.hook(provider="official", deepseek_api_key="sk-official"), (0, ""))
        self.assertEqual(json.loads(self.cat(self.data, "options.json")),
                         {"provider": "official", "deepseek_api_key": "sk-official", "custom_base_url": "", "custom_model": "",
                          "custom_api_key": ""})
        self.assertEqual(json.loads(self.cat(self.tmp, "config/dsk/plugin.json")),
                         {"options": f"{self.data}/options.json", "id": "dsk@acme"})
        self.assertEqual(os.stat(f"{self.data}/options.json").st_mode & 0o777, 0o600)
        code, out, _ = self.dsk("configure")
        self.assertEqual((code, out.splitlines()), (0, ["dsk · ready · official · https://api.deepseek.com · deepseek-flash",
                                                        "official: https://api.deepseek.com · deepseek-flash · key set"]))
        before = os.stat(f"{self.data}/options.json").st_mtime_ns
        self.hook(provider="official", deepseek_api_key="sk-official")  # before the next prompt: nothing changed, nothing written
        self.assertEqual(os.stat(f"{self.data}/options.json").st_mtime_ns, before)

    def test_custom_provider_runs_on_its_endpoint_with_its_model_and_key(self):
        custom = {"provider": "custom", "custom_base_url": self.api.url + "/c", "custom_model": "my-model", "custom_api_key": "sk-custom"}
        self.hook(**custom)
        self.api.replies = [script('done("x")')]
        out, _ = self.run_ok("task")
        request = self.api.chats()[0]
        self.assertIn(" · done · custom · ", out)
        self.assertEqual([request["path"], request["key"], json.loads(request["raw"])["model"]],
                         ["/c/chat/completions", "Bearer sk-custom", "my-model"])
        self.assertNotIn("sk-custom", json.dumps(dsk.clean_env(dsk.config(), self.tmp)))
        self.hook(**custom, deepseek_api_key="sk-official")  # with a DeepSeek key as well, the official API is the fallback
        self.assertEqual(self.dsk("configure")[1].splitlines()[1:],
                         [f"custom:  {self.api.url}/c · my-model · key set", "official: https://api.deepseek.com · deepseek-flash · key set"])
        self.hook(**{**custom, "provider": "official"}, deepseek_api_key="sk-official")  # the picker decides which one runs
        self.assertEqual(self.dsk("configure")[1].splitlines()[0], "dsk · ready · official · https://api.deepseek.com · deepseek-flash")

    def test_what_is_missing_is_said_at_session_start_and_a_hook_never_blocks(self):
        code, out = self.hook("--announce")
        said = json.loads(out)
        self.assertEqual(code, 0)
        self.assertEqual(said["systemMessage"], "dsk is not set up yet: it has no DeepSeek API key. Run /plugin configure dsk@acme "
                         "and enter your DeepSeek API key, or pick provider `custom` and enter its endpoint URL, model name and API key. "
                         "Then restart Claude Code.")
        self.assertEqual(said["hookSpecificOutput"]["hookEventName"], "SessionStart")
        self.assertIn("Never ask for a key in the chat.", said["hookSpecificOutput"]["additionalContext"])
        self.assertEqual(self.hook(), (0, ""))  # before a prompt the options are stored and nothing is said
        code, out = self.hook("--announce", provider="custom", custom_base_url="https://example.invalid/v1")
        self.assertIn("dsk is not set up yet: provider custom still needs its model name, API key. ", json.loads(out)["systemMessage"])
        code, out, _ = self.dsk("configure")
        self.assertEqual((code, out.splitlines()[0]), (1, "dsk · not set up · provider custom still needs its model name, API key"))
        self.assertIn("next:    in Claude Code, /plugin configure dsk@acme: enter your DeepSeek API key", out)
        code, out, _ = self.dsk("run", "task")
        self.assertEqual(code, 1)
        self.assertIn("error: DEEPSEEK_API_KEY is not set. In Claude Code, run /plugin configure dsk@acme and enter", out)
        self.assertEqual(self.api.requests, [])
        self.assertEqual(self.hook("--announce", provider="official", deepseek_api_key="sk-official"), (0, ""))  # set up: silent
        with mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": "/dev/null/nowhere"}):  # even when it cannot write
            self.assertEqual(subprocess.run([sys.executable, DSK, "configure", "--hook", "--announce", "--data", "/dev/null/x"],
                                            env={**self.env, "XDG_CONFIG_HOME": "/dev/null/nowhere"}, input="{}", capture_output=True,
                                            text=True, timeout=60).returncode, 0)

    def test_a_config_file_and_the_env_file_win_over_the_plugins_options(self):
        self.hook(provider="custom", custom_base_url=self.api.url + "/c", custom_model="m", custom_api_key="sk-custom")
        with open(f"{self.tmp}/config/dsk/env", "w") as f:
            f.write("export DSK_CUSTOM_API_KEY='sk-from-the-env-file'\n")
        self.api.replies = [script('done("x")')]
        self.run_ok("task")
        self.assertEqual(self.api.chats()[0]["key"], "Bearer sk-from-the-env-file")
        self.write_config()  # the route and profiles a hand-written config.json names stand
        self.assertEqual(self.dsk("configure")[1].splitlines()[0], f"dsk · ready · a · {self.api.url}/a · model-a")

    def test_a_removed_plugin_takes_its_keys_with_it(self):
        self.hook(provider="official", deepseek_api_key="sk-official")
        self.assertEqual(self.dsk("configure")[0], 0)
        shutil.rmtree(self.data)  # Claude Code deletes the data folder when the plugin is uninstalled
        code, out, _ = self.dsk("configure")
        self.assertEqual((code, out.splitlines()[0]), (1, "dsk · not set up · it has no DeepSeek API key"))

    def test_the_file_parses_on_an_older_python_so_that_it_can_say_what_it_needs(self):
        with open(DSK, encoding="utf-8") as f:
            ast.parse(f.read(), feature_version=(3, 9))


class Parser(unittest.TestCase):
    def call(self, arguments, name="run_code"):
        return {"id": "c1", "type": "function", "function": {"name": name, "arguments": arguments}}

    def test_one_run_code_call_yields_its_script_unchanged(self):
        code = ('text = r\'\'\'x = """triple"""\npath = "C:\\temp\\new"\n```python\nprint("fence")\n```\n\'\'\'\n'
                'write("a.md", text)\n')
        reply = {"role": "assistant", "content": "", "tool_calls": [self.call(json.dumps({"code": code}))]}
        self.assertEqual(dsk.parse(reply), code)

    def test_anything_else_is_not_a_script(self):
        good = self.call('{"code": "print(1)"}')
        for calls in ([], [good, good], [self.call('{"code": "print(1)"}', "write_file")], [self.call('{"code": "print(1')],
                      [self.call('{"script": "print(1)"}')], [self.call('{"code": ["print(1)"]}')], [self.call('"print(1)"')]):
            self.assertIsNone(dsk.parse({"role": "assistant", "content": "", "tool_calls": calls}), calls)
        self.assertIsNone(dsk.parse({"role": "assistant", "content": "prose only"}))


class Gate(unittest.TestCase):
    def test_refusals_are_one_line_and_name_the_alternative(self):
        cases = {"import os": "sh()", "import os.path as p": "sh()", "import subprocess": "sh()",
                 "from pathlib import Path": "read()", "import requests": "fetch()", "import sys": "done()",
                 "import mypackage.core": "sh('python3 ...') to run the project's own code", "from . import x": "import",
                 "open('x')": "read()", "f = open": "read()", "import io\nio.open('x')": "read()",
                 "from io import open": "read()", "exec('1')": "plain code", "eval('1')": "plain code",
                 "compile('1', '', 'exec')": "plain code", "__import__('os')": "__",
                 "input()": "ask()", "x = ().__class__": "__", "print(__builtins__)": "__",
                 "if __name__ == '__main__':\n    pass": "top-level"}
        for code, hint in cases.items():
            reason = dsk.gate(code)
            self.assertIsNotNone(reason, code)
            self.assertIn(hint, reason)
            self.assertNotIn("\n", reason)

    def test_allowed_modules_and_ordinary_code_pass(self):
        code = "\n".join(f"import {m}" for m in dsk.IMPORTS) + '''
from collections import Counter
class Box:
    def __init__(self, v):
        self.v = v
pattern = re.compile(r"x+")
print([Box(n).v for n in range(3)], Counter("abc"), io.StringIO("x").read(), read("a.txt")[:10])
'''
        self.assertIsNone(dsk.gate(code))

    def test_syntax_errors_are_reported_not_run(self):
        self.assertRegex(dsk.gate("def broken(:\n    pass"), r"^SyntaxError on line 1")


class Loop(Cli):
    def test_ask_stops_the_script_and_the_answer_extends_the_same_request(self):
        repo = self.repo({"a.txt": "one\n"})
        self.api.replies = [script('print("before")\nask("Which file?")\nprint("after")'),
                            script('print(read("a.txt"))\ndone("It says one.")')]
        out, sid = self.run_ok("look at the file", cwd=repo, code=2)
        self.assertRegex(out, r"^dsk \w{4} · question · a · 1 turn · in \d+\.\dk \(0% cached\) · out \d+\.\dk\n")
        self.assertEqual(out.splitlines()[1:], ["question: Which file?", f'next:    dsk answer {sid} "..."'])
        code, out, _ = self.dsk("answer", sid, "a.txt please", cwd=repo)
        self.assertEqual(code, 0, out)
        self.assertEqual(out.splitlines()[1:], ["answer:  It says one.", f"next:    dsk show {sid} --answer"])
        self.assertIn("· done · a · 2 turns ·", out)
        first, second = self.api.bodies()
        self.assertEqual([m["role"] for m in second["messages"]], ["system", "user", "assistant", "tool"])
        self.assertEqual(second["messages"][:2], first["messages"])
        self.assertEqual(self.back(1), "turn 1 · 11 left\noutput:\nbefore\n\nlead's answer: a.txt please")

    def test_exception_returns_a_short_traceback(self):
        self.api.replies = [script('def f():\n    return {}["missing"]\nprint("start")\nf()'), script('done("gave up")')]
        self.run_ok("try")
        self.assertEqual(self.back(1), 'turn 1 · 11 left\noutput:\nstart\nerror:\n  line 4: f()\n'
                                       '  line 2: return {}["missing"]\nKeyError: \'missing\'')

    def test_hard_timeout_kills_the_whole_process_group(self):
        self.config["limits"] = {"turn_seconds": 1}
        self.write_config()
        self.api.replies = [script('print("started", flush=True)\nsh("sleep 47.123 & sleep 47.123")'), script('done("x")')]
        self.run_ok("hang")
        self.assertIn("output:\nstarted\nerror:\ntimed out after 1s", self.back(1))
        self.assertEqual(subprocess.run(["pgrep", "-f", "sleep 47.123"], capture_output=True).returncode, 1)

    def test_sh_timeout_and_background_processes_end_with_the_command(self):
        self.api.replies = [script('r = sh("sleep 48.321", timeout=0.3)\nprint(r.code, r.out.strip())\n'
                                   'sh("sleep 48.321 &")\nprint(sh("pgrep -f \'[s]leep 48.321\' | wc -l").out.strip())\n'
                                   'done("x")')]
        _, sid = self.run_ok("background")
        self.assertEqual(self.output(sid, 1), "124 [killed after 0.3s]\n0\n")

    def test_environment_is_scrubbed_and_keys_never_reach_disk(self):
        self.env.update(MY_API_TOKEN="leak", AWS_PROFILE="leak", GITHUB_TOKEN="leak", SSH_AUTH_SOCK="/leak",
                        DB_PASSWORD="leak", npm_config_authtoken="leak", KEEP_SECRET="kept", PLAIN="kept")
        self.config["env_pass"] = ["KEEP_SECRET", "KEY_A"]
        self.write_config()
        self.api.replies = [script('print(sh("env").out)\ndone("x")')]
        _, sid = self.run_ok("env")
        seen = dict(line.split("=", 1) for line in self.output(sid, 1).splitlines() if "=" in line)
        for gone in ("KEY_A", "KEY_B", "KEY_S", "MY_API_TOKEN", "AWS_PROFILE", "GITHUB_TOKEN", "SSH_AUTH_SOCK",
                     "DB_PASSWORD", "npm_config_authtoken"):
            self.assertNotIn(gone, seen)
        expected = {"KEEP_SECRET": "kept", "PLAIN": "kept", "KUBECONFIG": "/dev/null", "PYTHONHASHSEED": "0",
                    "AWS_SHARED_CREDENTIALS_FILE": "/dev/null", "GIT_TERMINAL_PROMPT": "0", "TZ": "UTC"}
        self.assertEqual({k: seen.get(k) for k in expected}, expected)
        self.assertEqual(os.listdir(seen["DOCKER_CONFIG"]), [])
        leaked = subprocess.run(["grep", "-rl", "sk-fake", f"{self.tmp}/state"], capture_output=True, text=True).stdout
        self.assertEqual(leaked, "")

    def test_denied_commands_paths_and_out_of_scope_writes_are_refused(self):
        repo = self.repo({"src/a.py": "a = 1\n", "tests/t.py": "t = 1\n"})
        self.put(repo, {"tests/list.txt": "needle\n"})
        attempts = ['sh("git commit -m x")', 'sh("cd . && git push")', 'sh("/usr/bin/git stash")', 'sh("sudo ls")',
                    'sh("pip install x")', 'read("../outside.txt")', 'read("/etc/hosts")', 'write("../x", "1")',
                    'write("src/a.py", "1")', 'edit("src/a.py", "a", "b")', 'write("t.py", "1")', 'search("q")',
                    'fetch("http://x")']
        body = "attempts = [" + ", ".join(f"lambda: {a}" for a in attempts) + """]
for attempt in attempts:
    try:
        attempt()
        print("ALLOWED")
    except PermissionError as e:
        print("refused:", e)
write("tests/new/deep.py", "ok = 1\\n")
edit("tests/t.py", "t = 1", "t = 2")
print(sh("git status --short").code, sh("git -C . log --oneline -1").code, sh("git --no-pager diff --stat").code,
      grep("needle", glob("tests/*.txt")) == grep("needle", "tests/*.txt") == [("tests/list.txt", 1, "needle")])
done("tried everything")"""
        self.api.replies = [script(body)]
        out, sid = self.run_ok("--allow", "tests/**", "probe", cwd=repo)
        printed = self.output(sid, 1).splitlines()
        self.assertEqual([line[:8] for line in printed[:-1]], ["refused:"] * len(attempts), printed)
        self.assertEqual(printed[-1], "0 0 0 True")
        self.assertIn("src/a.py does not match the allow patterns (tests/**)", printed[8])
        self.assertIn("needs --web", printed[11])
        self.assertEqual((self.cat(repo, "src/a.py"), self.cat(repo, "tests/t.py"), self.cat(repo, "tests/new/deep.py")),
                         ("a = 1\n", "t = 2\n", "ok = 1\n"))
        self.assertIn("changed: tests/new/deep.py (+1), tests/t.py (+1 -1)", out)

    def test_file_content_with_fences_backslashes_and_triple_quotes_reaches_disk_unchanged(self):
        repo = self.repo({"src/a.py": "a = 1\n"})
        content = 'doc = """triple"""\nwin = "C:\\temp\\new"\nrx = r"\\d+\\n"\n```python\nprint("fence")\n```\n'
        self.api.replies = [script(f"write('tests/t.md', r'''{content}''')\ndone('wrote it')")]
        out, _ = self.run_ok("--allow", "tests/**", "write", cwd=repo)
        self.assertEqual(self.cat(repo, "tests/t.md"), content)
        self.assertIn("changed: tests/t.md (+6)", out)

    def test_long_output_is_capped_and_the_rest_is_readable(self):
        self.api.replies = [script('print("A" * 9000 + "B" * 11000)'),
                            script('print(len(read("@1")), read("@1", 1, 1)[:3])\ndone("x")')]
        _, sid = self.run_ok("print a lot")
        capped = self.back(1)
        self.assertLess(len(capped), 6200)
        self.assertIn('AAA\n[... 14001 characters cut here; read("@1") returns all of it ...]\nBBB', capped)
        self.assertEqual(self.output(sid, 2), "20001 AAA\n")

    def test_malformed_refused_and_truncated_replies_get_fixed_messages_then_stuck(self):
        self.api.replies = ["I think the answer is 4.", script("import os\nprint(os.getcwd())"),
                            {"arguments": '{"code": "print(1', "finish": "length"}]
        out, sid = self.run_ok("fail three times", code=3)
        second, third = (self.api.bodies()[n]["messages"][-1] for n in (1, 2))
        self.assertEqual((second["role"], second["content"]), ("user", "turn 1 · 11 left\n" + dsk.NUDGE))
        self.assertEqual((third["role"], third["content"]), ("tool", "turn 2 · 10 left\nrefused, nothing was run: "
                                                                     "import os is not allowed; use sh(), glob() and read()"))
        log = dsk.Session(sid)
        self.assertEqual(log.last("result")["text"], "turn 3 · 9 left\n" + dsk.TRUNCATED)
        self.assertEqual([r["fail"] for r in log.of("result")], ["malformed", "refused", "truncated"])
        self.assertIn("· stuck · a · 3 turns ·", out)
        self.assertIn("why:     three failing turns in a row", out)
        self.assertTrue(out.rstrip().endswith(f'dsk reject {sid} "guidance" | dsk reject {sid} --drop'))

    def test_several_calls_in_one_reply_are_not_run_and_each_is_answered(self):
        two = [{"arguments": json.dumps({"code": "print(1)"})}, {"arguments": json.dumps({"code": "print(2)"})}]
        self.api.replies = [{"calls": two}, script('done("x")')]
        _, sid = self.run_ok("two calls")
        answers = self.api.bodies()[1]["messages"][-2:]
        self.assertEqual([(m["role"], m["tool_call_id"]) for m in answers], [("tool", "call_0_0"), ("tool", "call_0_1")])
        self.assertEqual([m["content"] for m in answers], [dsk.ONE_CALL, "turn 1 · 11 left\n" + dsk.NUDGE])
        self.assertFalse(os.path.exists(f"{self.tmp}/state/dsk/{sid}/out/1"))

    def test_same_reply_twice_is_stuck_and_not_run_again(self):
        self.api.replies = [script('print("once")')] * 2
        out, sid = self.run_ok("repeat", code=3)
        self.assertIn("why:     same reply twice in a row", out)
        self.assertEqual(self.output(sid, 1), "once\n")
        self.assertFalse(os.path.exists(f"{self.tmp}/state/dsk/{sid}/out/2"))

    def test_turn_limit(self):
        self.api.replies = [script(f'print({n})') for n in range(3)]
        out, _ = self.run_ok("--max-turns", "3", "never finishes", code=3)
        self.assertIn("· limit · a · 3 turns ·", out)
        self.assertIn("why:     turn limit reached", out)
        self.assertEqual(self.back(2), "turn 2 · 1 left\noutput:\n1")

    def test_thinking_mode_replays_reasoning_and_does_not_force_the_call(self):
        self.api.replies = [{"code": 'print("a")', "message": {"reasoning_content": "plan: print a"}}, script('done("x")')]
        self.run_ok("--effort", "low", "think")
        first, second = self.api.bodies()
        self.assertEqual((first["tool_choice"], first["reasoning_effort"], first["max_tokens"]), ("auto", "low", 32000))
        self.assertEqual(second["messages"][2]["reasoning_content"], "plan: print a")

    def test_brief_from_a_file_stdin_attachment_and_a_run_started_in_a_subdirectory(self):
        repo = self.repo({"docs/brief.txt": "Summarise the notes.\n", "sub dir/ñandú notes.txt": "héllo\n", "tests/t.py": "t = 1\n"})
        self.api.replies = [script('print(read("@stdin").strip(), end=" ")\n'
                                   'print(read("sub dir/ñandú notes.txt").strip(), glob("sub dir/*"))\n'
                                   'write("sub dir/out put.txt", "résumé\\n")\ndone("Wrote the summary.")')]
        code, out, err = self.dsk("run", "--brief", "../docs/brief.txt", "--file", "-", "--file", "ñandú notes.txt",
                                  "--allow", "sub dir/**", cwd=f"{repo}/sub dir", stdin="piped in\n")
        self.assertEqual(code, 0, out + err)
        first = self.api.bodies()[0]["messages"][1]["content"]
        self.assertIn('<attached path="@stdin">\npiped in\n\n</attached>', first)
        self.assertIn('<attached path="sub dir/ñandú notes.txt">\nhéllo\n', first)
        self.assertTrue(first.endswith("## Task\nSummarise the notes."))
        sid = out.split()[1]
        self.assertEqual(self.output(sid, 1), "piped in héllo ['sub dir/ñandú notes.txt']\n")
        self.assertIn("changed: sub dir/out put.txt (+1)\n", out)
        self.assertIn("+résumé", self.dsk("show", sid, "--diff", cwd=repo)[1])
        self.assertEqual(self.dsk("reject", sid, "--drop", cwd=repo)[0], 0)
        self.assertFalse(os.path.exists(f"{repo}/sub dir/out put.txt"))

    def test_usage_errors_exit_1_not_2(self):
        for args in (["run"], ["run", "--effort", "extreme", "x"], ["bogus"], ["answer", "zzzz", "text"],
                     ["run", "--allow", "x", "outside a repository"], ["run", "--profile", "nope", "x"]):
            code, out, _ = self.dsk(*args)
            self.assertEqual((code, out[:12]), (1, "dsk · error:"), args)
        self.assertEqual(self.api.requests, [])


class Gates(Cli):
    def test_failed_check_goes_back_to_the_worker_and_the_run_continues(self):
        repo = self.repo({"tests/t.sh": "exit 0\n"})
        self.api.replies = [script('write("tests/t.sh", "echo broken; exit 3\\n")\ndone("first try")'),
                            script('write("tests/t.sh", "echo fine\\n")\ndone("Fixed the script.", "none")')]
        out, sid = self.run_ok("--allow", "tests/**", "--check", "sh tests/t.sh", "--check", "true", "fix it", cwd=repo)
        self.assertEqual(self.back(1), "turn 1 · 11 left\nwrote: tests/t.sh\noutput: (none)\n\n"
                                       "check failed: sh tests/t.sh → 3\nbroken")
        self.assertEqual(out.splitlines()[1:], [
            "summary: Fixed the script.", "open:    none", "checks:  sh tests/t.sh → 0; true → 0",
            "changed: tests/t.sh (+1 -1)",
            f'next:    dsk show {sid} --review | dsk accept {sid} | dsk reject {sid} "defects"'])
        self.assertIn("· review · a · 2 turns ·", out)
        header = self.api.bodies()[0]["messages"][1]["content"]
        self.assertIn("## Run\nallow: tests/**\ncheck: sh tests/t.sh\ncheck: true\nweb: off\nturn limit: 12\ndate: ", header)

    def test_out_of_scope_changes_are_reverted_and_reported(self):
        repo = self.repo({"src/a.py": "a = 1\n", "src/gone.py": "x\n", "tests/t.py": "t = 1\n"})
        self.api.replies = [script('sh("echo hacked > src/a.py; rm src/gone.py; echo new > src/new.py; '
                                   'echo t2 >> tests/t.py")\ndone("x")')]
        out, _ = self.run_ok("--allow", "tests/**", "--check", "touch src/artifact.log", "edit", cwd=repo)
        self.assertEqual((self.cat(repo, "src/a.py"), self.cat(repo, "src/gone.py"), self.cat(repo, "tests/t.py")),
                         ("a = 1\n", "x\n", "t = 1\nt2\n"))
        self.assertEqual(sorted(os.listdir(f"{repo}/src")), ["a.py", "gone.py"])
        self.assertIn("scope:   reverted src/a.py, src/gone.py, src/new.py, src/artifact.log (copies in ", out)
        kept = out.split("(copies in ")[1].split(")")[0]
        self.assertEqual((self.cat(kept, "src/a.py"), self.cat(kept, "src/new.py"), self.cat(kept, "src/artifact.log")),
                         ("hacked\n", "new\n", ""))
        self.assertIn("changed: tests/t.py (+1)\n", out)

    def test_diff_excludes_my_uncommitted_changes_and_my_index_is_untouched(self):
        repo = self.repo({"mine.txt": "v1\n", "tests/t.py": "t = 1\n"})
        self.put(repo, {"mine.txt": "v2, uncommitted\n", "untracked.txt": "u\n", "staged.txt": "s\n"})
        self.git(repo, "add", "staged.txt")
        before = self.git(repo, "status", "--porcelain").splitlines()
        self.assertEqual(len(before), 3)
        self.api.replies = [script('edit("tests/t.py", "t = 1", "t = 2")\ndone("x")')]
        out, _ = self.run_ok("--allow", "tests/**", "edit", cwd=repo)
        self.assertIn("changed: tests/t.py (+1 -1)\n", out)
        self.assertNotIn("mine.txt", out)
        self.assertEqual(sorted(self.git(repo, "status", "--porcelain").splitlines()), sorted(before + [" M tests/t.py"]))
        self.assertEqual(self.cat(repo, "mine.txt"), "v2, uncommitted\n")

    def test_snapshot_sees_a_same_size_edit_made_in_the_same_second_as_the_commit(self):
        repo = self.repo({"a.txt": "t = 1\n"})
        committed, indexed = self.git(repo, "rev-parse", "HEAD^{tree}").strip(), os.stat(f"{repo}/.git/index").st_mtime
        self.put(repo, {"a.txt": "t = 2\n"})
        os.utime(f"{repo}/a.txt", (indexed, indexed))
        __import__("time").sleep(1.1)  # the session's copy of my index must not look newer than the edit
        self.assertNotEqual(dsk.snapshot(repo, f"{self.tmp}/session-index"), committed)

    def test_edits_made_by_someone_else_during_a_run_are_left_alone(self):
        repo = self.repo({"a.txt": "one\n", "src/a.py": "a = 1\n", "tests/t.py": "t = 1\n"})
        mine = {"a.txt": "one, edited by me while dsk was running\n", "new-by-me.txt": "mine\n"}
        self.api.between_turns[2] = lambda: self.put(repo, mine)
        self.api.replies = [script('print(read("a.txt"))'), script('done("It said one.")')]
        out, _ = self.run_ok("what does a.txt say?", cwd=repo)
        self.assertEqual({name: self.cat(repo, name) for name in mine}, mine)
        self.assertNotIn("scope:", out)
        later = {"src/a.py": "a = 2  # my edit, outside the worker's scope\n", "tests/mine.py": "inside its scope, still mine\n"}
        self.api.between_turns[4] = lambda: self.put(repo, later)
        self.api.replies = [script('edit("tests/t.py", "t = 1", "t = 2")\nsh("echo stray > src/stray.py")'), script('done("x")')]
        out, sid = self.run_ok("--allow", "tests/**", "--check", "true", "edit", cwd=repo)
        self.assertEqual(({name: self.cat(repo, name) for name in later}, os.path.exists(f"{repo}/src/stray.py")), (later, False))
        self.assertIn("scope:   reverted src/stray.py (copies in ", out)
        self.assertIn("reverted, outside the allow patterns: src/stray.py", self.back(3))
        self.assertIn("changed: tests/t.py (+1 -1)\n", out)
        self.assertNotIn("mine.py", self.dsk("show", sid, "--diff", cwd=repo)[1])
        self.assertEqual(self.dsk("reject", sid, "--drop", cwd=repo)[0], 0)
        self.assertEqual(({name: self.cat(repo, name) for name in later}, self.cat(repo, "tests/t.py")), (later, "t = 1\n"))

    def test_reverted_file_does_not_leave_stale_bytecode_behind(self):
        repo = self.repo({".gitignore": "__pycache__/\n", "flag.py": "VALUE = 1\n", "tests/t.py": "t = 1\n"})
        self.api.replies = [script('sh("printf \'VALUE = 2\\n\' > flag.py && python3 -c \'import flag\'")\n'
                                   'edit("tests/t.py", "t = 1", "t = 2")\ndone("x")')]
        out, _ = self.run_ok("--allow", "tests/**", "--check", "python3 -c 'import flag, sys; sys.exit(flag.VALUE != 1)'",
                             "edit", cwd=repo)
        self.assertIn("· review ·", out)
        self.assertIn("scope:   reverted flag.py (copies in ", out)

    def test_a_script_without_a_shell_command_is_charged_only_for_what_it_wrote(self):
        repo = self.repo({"src/a.py": "a = 1\n", "tests/t.py": "t = 1\n", "tests/u.py": "u = 1\n"})
        with mock.patch.object(dsk, "STATE", f"{self.tmp}/state/dsk"):
            log = dsk.Session()
            log.add("head", id=log.id, workdir=repo, root=repo, allow=["tests/**"], start=dsk.snapshot(repo, f"{log.dir}/index"))
            for turn, calls in ((1, ["write"]), (2, ["write", "sh"])):
                before = dsk.span(log)
                self.put(repo, {"src/a.py": f"a = {turn + 1}  # someone else, meanwhile\n", "tests/t.py": f"t = {turn + 1}\n",
                                "tests/u.py": f"u = {turn + 1}  # someone else, in scope\n"})
                log.shelled = 4242 if "sh" in calls else None
                log.add("ledger", turn=turn, fn="write", arg="./tests/t.py", code=0)
                reverted = dsk.settle(log, before, turn)
                self.assertEqual((reverted, log.last("gate")["touched"]),
                                 ([], ["tests/t.py"]) if turn == 1 else (["src/a.py"], ["tests/t.py", "tests/u.py"]))
        self.assertEqual(self.cat(repo, "src/a.py"), "a = 2  # someone else, meanwhile\n")

    def test_read_only_run_reverts_every_change(self):
        repo = self.repo({"a.txt": "one\n"})
        self.api.replies = [script('sh("echo two > a.txt; echo x > b.txt")\ndone("The file says one.")')]
        out, sid = self.run_ok("what does a.txt say?", cwd=repo)
        self.assertEqual((self.cat(repo, "a.txt"), os.path.exists(f"{repo}/b.txt")), ("one\n", False))
        self.assertEqual(out.splitlines()[1:], ["answer:  The file says one.",
                                               f"scope:   reverted a.txt, b.txt (copies in {self.tmp}/state/dsk/{sid}/reverted)",
                                               f"next:    dsk show {sid} --answer"])

    def test_stuck_report_carries_notes_and_the_scoped_partial_change(self):
        repo = self.repo({"src/a.py": "a = 1\n", "tests/t.py": "t = 1\n"})
        self.api.replies = [script('note("config lives in src/a.py")\nedit("tests/t.py", "t = 1", "t = 2")\n'
                                   'sh("echo hacked > src/a.py")')] * 2
        out, _ = self.run_ok("--allow", "tests/**", "edit", cwd=repo, code=3)
        self.assertIn("notes:   config lives in src/a.py\n", out)
        self.assertIn("scope:   reverted src/a.py (copies in ", out)
        self.assertIn("changed: tests/t.py (+1 -1)\n", out)
        self.assertEqual(self.cat(repo, "src/a.py"), "a = 1\n")


class Cache(Cli):
    def test_prefix_invariant_over_ten_turns_and_stable_first_ordering(self):
        repo = self.repo({"DSK.md": "# Project facts\nTests: sh tests/t.sh\n", "a.txt": "attached text\n"})
        self.api.replies = [script(f'print("step {n}")') for n in range(9)] + [script('done("ten turns")')]
        out, sid = self.run_ok("--file", "a.txt", "count to ten", cwd=repo)
        wires = [json.dumps(b["messages"], ensure_ascii=False, separators=(",", ":")) for b in self.api.bodies()]
        self.assertEqual(len(wires), 10)
        for shorter, longer in zip(wires, wires[1:]):
            self.assertTrue(longer.startswith(shorter[:-1]))
        for request, wire in zip(self.api.chats(), wires):
            self.assertIn(wire, request["raw"].decode())
        self.assertEqual(len({json.dumps(b["tools"]) for b in self.api.bodies()}), 1)
        first = self.api.bodies()[0]["messages"]
        self.assertEqual(first[0], {"role": "system", "content": dsk.SYSTEM})
        order = [first[1]["content"].index(part) for part in
                 ('<attached path="DSK.md">\n# Project facts', "## Run", '<attached path="a.txt">\nattached text', "## Task\ncount to ten")]
        self.assertEqual(order, sorted(order))
        self.assertEqual(order[0], 0)
        self.assertRegex(out, r"· done · a · 10 turns · in \d+\.\dk \(\d\d% cached\)")
        self.assertNotIn("cache:", out)
        usage = dsk.Session(sid).of("usage")
        self.assertGreater(min(u["hit"] / u["prompt"] for u in usage[2:]), 0.9)

    def test_system_prompt_bytes_are_identical_across_projects_and_profiles(self):
        one, two = self.repo({"DSK.md": "project one\n"}), self.repo({"x/y.txt": "other\n"})
        self.api.replies = [script('done("a")'), script('done("b")')]
        self.run_ok("--profile", "a", "task one", cwd=one)
        self.run_ok("--profile", "b", "--effort", "high", "task two", cwd=two)
        a, b = self.api.chats()
        self.assertNotEqual(a["path"], b["path"])
        prefix = '"messages":[{"role":"system","content":' + json.dumps(dsk.SYSTEM, ensure_ascii=False) + "},"
        for request in (a, b):
            self.assertIn(prefix, request["raw"].decode())

    def test_low_cache_share_is_flagged(self):
        usage = {"prompt_tokens": 1000, "completion_tokens": 10, "prompt_cache_hit_tokens": 100}
        self.api.replies = [{"code": f'print({n})', "usage": usage} for n in range(5)] + \
                           [{"code": 'done("x")', "usage": usage}]
        out, _ = self.run_ok("uncached provider")
        self.assertIn("cache:   low (10% cached after turn 3)\n", out)



class Compaction(Cli):
    def long_run(self):
        """Six turns with a note, a question and an edit. The big attached file pushes the prompt past
        `compact_at`, so the series is compacted once, as early as there is a turn to drop."""
        self.config["profiles"]["a"]["compact_at"] = 4000
        self.write_config()
        repo = self.repo({"big.txt": "x" * 20000 + "\n", "small.txt": "the rules, in 30 characters\n", "tests/t.py": "t = 1\n"})
        self.api.replies = [script('note("alpha is 1")\nedit("tests/t.py", "t = 1", "t = 2")\nprint(sh("true").code)'),
                            script('ask("Which name?")'), script('print("three")'), script('print("four")'),
                            script('print("five")'), script('done("six turns")')]
        _, sid = self.run_ok("--file", "big.txt", "--file", "small.txt", "--allow", "tests/**", "long task", cwd=repo, code=2)
        code, out, _ = self.dsk("answer", sid, "Use beta.", cwd=repo)
        self.assertEqual(code, 0, out)
        return dsk.Session(sid)

    def test_digest_keeps_notes_answers_and_actions_and_drops_the_attached_file(self):
        log = self.long_run()
        self.assertEqual([(r["why"], r.get("turn")) for r in log.of("series")], [("start", None), ("compact", 3)])
        before, after = (self.api.bodies()[n]["messages"] for n in (2, 3))
        self.assertIn('<attached path="big.txt">', before[1]["content"])
        self.assertEqual([m["role"] for m in after], ["system", "user", "assistant", "tool", "assistant", "tool", "user"])
        self.assertEqual(after[0], before[0])
        self.assertEqual(after[2:4], before[4:])
        self.assertEqual(after[5]["content"], "turn 3 · 9 left\noutput:\nthree")
        self.assertEqual(after[6]["content"], "Older turns were dropped to save space, and so were the attached copies of: big.txt. "
                                              "Read a file again before you rely on what it said.")
        first = after[1]["content"]
        self.assertNotIn('<attached path="big.txt">', first)
        self.assertIn('<attached path="small.txt">\nthe rules, in 30 characters\n\n</attached>\n\n## Task\n', first)
        self.assertTrue(first.endswith(
            "## Task\nlong task\n\n## Digest of turns 1-1, whose messages were dropped\nnote: alpha is 1\n"
            "you asked: Which name?\nthe lead answered: Use beta.\nt1 edit tests/t.py\nt1 sh true → 0\n"
            "files changed so far: tests/t.py"), first[-400:])

    def test_requests_after_compaction_are_append_only_again(self):
        self.long_run()
        wires = [json.dumps(b["messages"], ensure_ascii=False, separators=(",", ":")) for b in self.api.bodies()]
        extends = [later.startswith(earlier[:-1]) for earlier, later in zip(wires, wires[1:])]
        self.assertEqual(extends, [True, True, False, True, True])

    def test_the_same_log_compacts_to_the_same_bytes(self):
        log = self.long_run()
        cut = next(i for i, r in enumerate(log.recs) if r["t"] == "series" and r["why"] == "compact")
        logged = [{"turn": r["turn"], "m": r["m"]} for r in log.recs[cut + 1:cut + 8]]
        self.assertEqual(dsk.compaction(log.recs[:cut], log.recs[cut]["changed"]), logged)
        program = ("import importlib.util, json, sys\n"
                   f"spec = importlib.util.spec_from_file_location('dsk', {DSK!r})\n"
                   "dsk = importlib.util.module_from_spec(spec); spec.loader.exec_module(dsk)\n"
                   f"recs = [json.loads(line) for line in open({log.path!r})][:{cut}]\n"
                   f"sys.stdout.write(dsk.dumps(dsk.compaction(recs, {log.recs[cut]['changed']!r})))")
        outputs = {subprocess.run([sys.executable, "-c", program], env={**self.env, "PYTHONHASHSEED": seed},
                                  capture_output=True, text=True).stdout for seed in ("1", "2", "3")}
        self.assertEqual(outputs, {dsk.dumps(logged)})


class Review(Cli):
    WORK = ('note("t.py holds the constant")\nedit("tests/t.py", "t = 1", "t = 2")\n'
            'write("tests/new.py", "n = 1\\n")\ndone("Bumped t and added new.py.")')

    def delegated(self, *flags):
        repo = self.repo({"src/a.py": "a = 1\n", "tests/t.py": "t = 1\n"})
        self.api.replies = [script(self.WORK)]
        out, sid = self.run_ok(*flags, "--allow", "tests/**", "--check", "true", "bump t", cwd=repo)
        self.assertIn("· review ·", out)
        return repo, sid

    def state(self, sid):
        return dsk.Session(sid).status()

    def test_review_packet_diff_log_and_answer(self):
        repo, sid = self.delegated()
        packet = self.dsk("show", sid, "--review", cwd=repo)[1].splitlines()
        self.assertEqual(packet[1:8], ["brief:   bump t", "allow:   tests/**", "notes:   t.py holds the constant",
                                       "summary: Bumped t and added new.py.", "checks:  true → 0",
                                       "changed: tests/new.py (+1), tests/t.py (+1 -1)", "diff --git a/tests/new.py b/tests/new.py"])
        self.assertTrue({"+n = 1", "-t = 1", "+t = 2"} <= set(packet))
        self.assertEqual(packet[-1], f'next:    dsk show {sid} --review | dsk accept {sid} | dsk reject {sid} "defects"')
        self.assertEqual(self.dsk("show", sid, cwd=repo)[1].splitlines()[1], "summary: Bumped t and added new.py.")
        self.assertIn("+t = 2\n", self.dsk("show", sid, "--diff", cwd=repo)[1])
        self.assertEqual(self.dsk("show", sid, "--answer", cwd=repo)[1], "Bumped t and added new.py.\n")
        self.assertRegex(self.dsk("show", sid, "--log", cwd=repo)[1],
                         r"^-- new series: start on a\nt1 +in +\d+ hit +0 miss +\d+ out +\d+ \| note t.py holds the constant; "
                         r"edit tests/t.py; write tests/new.py; done Bumped t and added new.py.\n$")

    def test_accept_in_place_only_marks_the_session(self):
        repo, sid = self.delegated()
        self.assertEqual(self.dsk("accept", sid, cwd=repo)[:2], (0, f"dsk {sid} · accepted · 2 files already in your working tree\n"))
        self.assertEqual((self.cat(repo, "tests/t.py"), self.state(sid)), ("t = 2\n", "accepted"))
        code, out, _ = self.dsk("accept", sid, cwd=repo)
        self.assertEqual((code, out), (1, f"dsk · error: session {sid} is accepted; this command needs review or stuck or limit\n"))

    def test_reject_sends_defects_into_the_same_series_with_a_fresh_turn_budget(self):
        repo, sid = self.delegated()
        self.api.replies = [script('edit("tests/t.py", "t = 2", "t = 3")\ndone("Now it is 3.")')]
        code, out, _ = self.dsk("reject", sid, "1. t must be 3", cwd=repo)
        self.assertEqual(code, 0, out)
        self.assertIn("· review · a · 2 turns ·", out)
        self.assertIn("summary: Now it is 3.", out)
        first, second = (json.dumps(b["messages"], ensure_ascii=False, separators=(",", ":")) for b in self.api.bodies())
        self.assertTrue(second.startswith(first[:-1]))
        self.assertTrue(self.back(1).endswith("the lead reviewed this and rejected it. Fix these defects:\n1. t must be 3"))
        self.assertTrue(dsk.Session(sid).last("result")["text"].startswith("turn 2 · 11 left"))
        self.assertEqual(self.cat(repo, "tests/t.py"), "t = 3\n")
        packet = self.dsk("show", sid, "--review", cwd=repo)[1]
        self.assertIn(f"diff since your last review (the whole diff: dsk show {sid} --diff)\n", packet)
        self.assertTrue({"-t = 2", "+t = 3"} <= set(packet.splitlines()))
        self.assertNotIn("+n = 1", packet)
        self.assertTrue({"-t = 1", "+t = 3", "+n = 1"} <= set(self.dsk("show", sid, "--diff", cwd=repo)[1].splitlines()))

    def test_drop_in_place_restores_the_tree(self):
        repo, sid = self.delegated()
        self.put(repo, {"src/a.py": "a = 1  # edited by me after the run\n"})
        self.assertEqual(self.dsk("reject", sid, "--drop", cwd=repo)[:2], (0, f"dsk {sid} · dropped · the worker's changes were discarded\n"))
        self.assertEqual((self.cat(repo, "tests/t.py"), os.path.exists(f"{repo}/tests/new.py"), self.state(sid)),
                         ("t = 1\n", False, "dropped"))
        self.assertEqual(self.cat(repo, "src/a.py"), "a = 1  # edited by me after the run\n")

    def test_drop_refuses_as_a_whole_when_the_tree_has_moved(self):
        repo, sid = self.delegated()
        self.put(repo, {"tests/t.py": "t = 99\n"})
        code, out, _ = self.dsk("reject", sid, "--drop", cwd=repo)
        self.assertEqual(code, 1)
        self.assertIn("the tree has moved since the run, nothing was reverted", out)
        self.assertEqual((self.cat(repo, "tests/t.py"), self.cat(repo, "tests/new.py"), self.state(sid)),
                         ("t = 99\n", "n = 1\n", "review"))

    def test_worktree_run_is_seeded_with_my_state_and_accept_lands_uncommitted(self):
        repo = self.repo({"src/a.py": "a = 1\n", "tests/t.py": "t = 1\n"})
        self.put(repo, {"src/a.py": "a = 1  # my uncommitted edit\n", "mine.txt": "untracked\n"})
        self.api.replies = [script('print(read("src/a.py").strip(), read("mine.txt").strip())\n' + self.WORK)]
        out, sid = self.run_ok("--worktree", "--allow", "tests/**", "bump t", cwd=repo)
        self.assertEqual(self.output(sid, 1), "a = 1  # my uncommitted edit untracked\n")
        self.assertIn("changed: tests/new.py (+1), tests/t.py (+1 -1)", out)
        self.assertEqual((self.cat(repo, "tests/t.py"), os.path.exists(f"{repo}/tests/new.py")), ("t = 1\n", False))
        self.assertIn(f"dsk/{sid}", self.git(repo, "branch", "--list"))
        self.assertIn(f"where:   {self.tmp}/state/dsk/{sid}/wt\n", self.dsk("show", sid, "--review", cwd=repo)[1])
        head = self.git(repo, "rev-parse", "HEAD")
        self.assertEqual(self.dsk("accept", sid, cwd=repo)[:2],
                         (0, f"dsk {sid} · accepted · 2 files applied to your working tree, uncommitted\n"))
        self.assertEqual((self.cat(repo, "tests/t.py"), self.cat(repo, "tests/new.py")), ("t = 2\n", "n = 1\n"))
        self.assertEqual(self.git(repo, "rev-parse", "HEAD"), head)
        self.assertEqual(sorted(self.git(repo, "status", "--porcelain").splitlines()),
                         [" M src/a.py", " M tests/t.py", "?? mine.txt", "?? tests/new.py"])
        self.assertEqual(self.git(repo, "branch", "--list", f"dsk/{sid}"), "")
        self.assertFalse(os.path.exists(f"{self.tmp}/state/dsk/{sid}/wt"))

    def test_worktree_conflict_is_refused_atomically_and_drop_removes_the_worktree(self):
        repo, sid = self.delegated("--worktree")
        self.put(repo, {"tests/t.py": "t = 7  # I changed the same line\n"})
        code, out, _ = self.dsk("accept", sid, cwd=repo)
        self.assertEqual(code, 1)
        self.assertIn("conflict, nothing was applied and the session is still open", out)
        self.assertEqual((self.cat(repo, "tests/t.py"), os.path.exists(f"{repo}/tests/new.py"), self.state(sid)),
                         ("t = 7  # I changed the same line\n", False, "review"))
        self.assertTrue(os.path.exists(f"{self.tmp}/state/dsk/{sid}/wt/tests/new.py"))
        self.assertEqual(self.dsk("reject", sid, "--drop", cwd=repo)[0], 0)
        self.assertEqual((self.git(repo, "branch", "--list", f"dsk/{sid}"), os.path.exists(f"{self.tmp}/state/dsk/{sid}/wt")), ("", False))
        self.assertEqual(self.cat(repo, "tests/t.py"), "t = 7  # I changed the same line\n")


class Protocol(Cli):
    def test_error_state_has_exit_1_and_a_next_line(self):
        self.api.replies = [{"status": 400, "error": "bad request body"}]
        out, sid = self.run_ok("--profile", "a", "this fails", code=1)
        self.assertEqual(out.splitlines(), [f"dsk {sid} · error · a · 0 turns · in 0.0k · out 0.0k",
                                            'error:   a: HTTP 400 {"error": {"message": "bad request body"}}',
                                            f"next:    dsk show {sid} --log | dsk reject {sid} --drop"])
        self.assertEqual(self.dsk("reject", sid, "--drop")[0], 0)

    def hook(self, **event):
        done = subprocess.run([sys.executable, DSK, "status", "--hook"], env=self.env, capture_output=True, text=True,
                              input=json.dumps({"hook_event_name": "Stop", "cwd": self.tmp, **event}))
        return done.returncode, done.stderr

    def test_status_json_follows_a_run_through_its_phases(self):
        repo = self.repo({"tests/t.py": "t = 1\n"})
        status = f"{sys.executable} {DSK} status --json"
        self.api.between_turns[2] = lambda: self.put(self.tmp, {"model.json": self.dsk("status", "--json")[1]})
        self.api.replies = [script(f'read("tests/t.py")\nsh("{status} > {self.tmp}/script.json")'),
                            script('edit("tests/t.py", "t = 1", "t = 2")\ndone("x")')]
        out, sid = self.run_ok("--owner", "claude-1", "--allow", "tests/**", "--max-turns", "5",
                               "--check", f"{status} > {self.tmp}/checks.json", "edit  it\nnow", cwd=repo)
        seen = {name: json.loads(self.cat(self.tmp, f"{name}.json"))["jobs"] for name in ("script", "model", "checks")}
        seen["end"] = json.loads(self.dsk("status", "--json")[1])["jobs"]
        self.assertEqual({name: [[job[k] for k in ("status", "phase", "turn", "act")] for job in jobs]
                          for name, jobs in seen.items()},
                         {"script": [["running", "script", 0, "read tests/t.py"]], "model": [["running", "model", 1, ""]],
                          "checks": [["running", "checks", 1, "done x"]], "end": [["review", "", 2, ""]]})
        # `doing` is the shell command or check in flight, which here is the one that asked
        self.assertEqual([seen[name][0]["doing"] for name in ("script", "model", "checks", "end")],
                         [f"{status} > {self.tmp}/script.json"[:80], "", f"{status} > {self.tmp}/checks.json"[:80], ""])
        end = seen["end"][0]
        self.assertEqual([end["failover"], end["cost"]], ["", None])
        self.assertEqual([end[k] for k in ("id", "profile", "max_turns", "turns", "changed", "brief", "owner", "root", "note")],
                         [sid, "a", 5, 2, 1, "edit it now", "claude-1", repo, ""])
        self.assertIn(f"in {dsk.kilo(end['in'])} ({end['cached']:.0%} cached) · out {dsk.kilo(end['out'])}", out)
        self.assertLessEqual(end["created"], end["active"])

    def test_status_json_reads_a_stopped_log_once_and_reports_failover_and_cost(self):
        self.config["profiles"]["a"]["price"] = {"in": 2.0, "cached": 1.0, "out": 10.0}
        self.config["profiles"]["b"]["price"] = {"in": 4.0, "cached": 2.0, "out": 20.0}
        self.write_config()
        self.api.replies = [{"status": 429}, {"status": 429}, {"status": 429}, script('done("x")'), script('done("y")')]
        _, moved = self.run_ok("first")
        _, stayed = self.run_ok("--profile", "b", "second")
        first = {j["id"]: j for j in json.loads(self.dsk("status", "--json")[1])["jobs"]}
        self.assertEqual([first[moved]["failover"], first[moved]["profile"], first[stayed]["failover"]], ["a 429", "b", ""])
        usage = [r for r in dsk.Session(stayed).recs if r["t"] == "usage"]
        self.assertAlmostEqual(first[stayed]["cost"], sum((u["prompt"] - u["hit"]) * 4.0 + u["hit"] * 2.0 + u["out"] * 20.0
                                                          for u in usage) / 1e6)
        self.assertGreater(first[stayed]["cost"], 0)
        with mock.patch.object(dsk, "job", wraps=dsk.job) as job, mock.patch("builtins.print") as printed:
            self.assertEqual(dsk.cmd_status(mock.Mock(json=True, hook=False), dsk.config()), 0)
        self.assertEqual(job.call_count, 0)  # neither log has moved since its session stopped
        self.assertEqual({j["id"]: j for j in json.loads(printed.call_args[0][0])["jobs"]}, first)
        with open(os.path.join(self.tmp, "state/dsk", stayed, "log.jsonl"), "a") as f:
            f.write(json.dumps({"t": "state", "status": "accepted"}) + "\n")
        with mock.patch.object(dsk, "job", wraps=dsk.job) as job, mock.patch("builtins.print") as printed:
            dsk.cmd_status(mock.Mock(json=True, hook=False), dsk.config())
        self.assertEqual([c.args[0].id for c in job.call_args_list], [stayed])  # only the log that moved is read again
        self.assertEqual({j["id"]: j["status"] for j in json.loads(printed.call_args[0][0])["jobs"]},
                         {moved: "done", stayed: "accepted"})

    def test_owner_defaults_to_the_claude_code_session_that_runs_dsk(self):
        self.api.replies = [script('done("x")'), script('done("y")')]
        self.env["CLAUDE_CODE_SESSION_ID"] = "claude-7"
        _, mine = self.run_ok("no flag")
        _, named = self.run_ok("--owner", "claude-9", "flag wins")
        self.assertEqual([dsk.Session(mine).head["owner"], dsk.Session(named).head["owner"]], ["claude-7", "claude-9"])

    def test_stop_hook_blocks_only_for_the_owners_sessions_in_review(self):
        repo = self.repo({"tests/t.py": "t = 1\n"})
        self.api.replies = [script('edit("tests/t.py", "t = 1", "t = 2")\ndone("x")'), script('ask("Why?")')]
        _, sid = self.run_ok("--owner", "claude-1", "--allow", "tests/**", "edit", cwd=repo)
        self.run_ok("--owner", "claude-1", "a question", cwd=repo, code=2)
        self.assertEqual(self.hook(session_id="someone-else", stop_hook_active=False), (0, ""))
        code, err = self.hook(session_id="claude-1", stop_hook_active=False)
        self.assertEqual(code, 2)
        self.assertEqual(err, f'dsk {sid} is waiting for your review: run dsk show {sid} --review, then dsk accept {sid} '
                              f'or dsk reject {sid} "defects"\n')
        self.assertEqual(self.hook(session_id="claude-1", stop_hook_active=True), (0, ""))
        self.dsk("accept", sid, cwd=repo)
        self.assertEqual(self.hook(session_id="claude-1", stop_hook_active=False), (0, ""))

    def test_a_running_session_is_busy_and_shows_as_running(self):
        self.api.replies = [script('sh("sleep 49.873")')]
        proc = subprocess.Popen([sys.executable, DSK, "run", "long one"], cwd=self.tmp, env=self.env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(proc.kill)
        self.wait_for("sleep 49.873")
        sid = os.listdir(f"{self.tmp}/state/dsk")[0]
        with open(f"{self.tmp}/state/dsk/{sid}/log.jsonl", "a") as f:
            f.write('{"t": "torn rec')
        os.makedirs(f"{self.tmp}/state/dsk/zzzz")
        self.assertRegex(self.dsk("status")[1], rf"^dsk {sid} · running · .*\n1 open, 0 finished\n")
        self.assertRegex(self.dsk("show", sid)[1], rf"^dsk {sid} · running · a · 1 turn · ")
        code, out, _ = self.dsk("reject", sid, "--drop")
        self.assertEqual((code, out), (1, f"dsk · error: session {sid} is busy: another dsk process is running it\n"))
        proc.terminate()
        proc.communicate(timeout=30)

    def test_only_one_in_place_run_per_tree_and_worktree_runs_are_exempt(self):
        repo = self.repo({"tests/t.py": "t = 1\n"})
        self.api.replies = [script('sh("sleep 49.874")'), script('done("in the worktree")')]
        first = subprocess.Popen([sys.executable, DSK, "run", "slow one"], cwd=repo, env=self.env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(first.kill)
        self.wait_for("sleep 49.874")
        code, out, _ = self.dsk("run", "second in place", cwd=repo)
        self.assertEqual((code, out), (1, "dsk · error: another dsk run is working in this tree: wait for it, or use --worktree\n"))
        self.assertEqual(len(os.listdir(f"{self.tmp}/state/dsk")), 2)  # the first session and the tree lock, no orphan
        self.api.replies.append(script('write("tests/new.py", "n = 1\\n")\ndone("isolated work")'))
        out, _ = self.run_ok("--worktree", "third, isolated", cwd=repo)
        self.assertIn("· done ·", out)
        out, sid = self.run_ok("--worktree", "--allow", "tests/**", "fourth, isolated and writing", cwd=repo)
        code, out, _ = self.dsk("accept", sid, cwd=repo)  # applying it would change the tree the first run works in
        self.assertEqual((code, out), (1, "dsk · error: another dsk run is working in this tree: wait for it, or use --worktree\n"))
        self.assertFalse(os.path.exists(f"{repo}/tests/new.py"))
        first.terminate()
        first.communicate(timeout=30)
        self.assertEqual(self.dsk("accept", sid, cwd=repo)[0], 0)
        self.assertEqual(self.cat(repo, "tests/new.py"), "n = 1\n")

    def test_status_lists_this_projects_open_sessions(self):
        one, two = self.repo({"a.txt": "1\n"}), self.repo({"b.txt": "2\n"})
        self.api.replies = [script('ask("First?")'), script('ask("Second?")'), script('done("read-only answer")')]
        _, first = self.run_ok("question in project one", cwd=one, code=2)
        self.run_ok("question in project two", cwd=two, code=2)
        self.run_ok("finished in project one", cwd=one)
        lines = self.dsk("status", cwd=one)[1].splitlines()
        self.assertRegex(lines[0], rf"^dsk {first} · question · 0h00m ago · question in project one$")
        self.assertEqual(lines[1:], ["1 open, 1 finished", f"next:    dsk show {first}"])

    def test_failover_on_402_during_a_run(self):
        self.api.replies = [{"status": 402}, script('done("served by b")')]
        out, sid = self.run_ok("fail over")
        self.assertIn("· done · b · 1 turn ·", out)
        self.assertIn("-- new series: failover on b\n", self.dsk("show", sid, "--log")[1])

    def test_web_calls_run_in_the_parent_and_unseen_urls_are_flagged(self):
        self.api.search_results = [{"title": "T", "url": "https://ok.example/a", "date": "2026-01-01T00:00:00Z",
                                    "summary": "S", "rerank_score": 2.1, "authority": 3}]
        self.api.pages = {"https://ok.example/b": {"title": "Page B", "content": "Body of B."}}
        body = ('r = search("deepseek cache")\nprint(r[0]["url"], r[0]["title"], sorted(r[0]))\n'
                'print(fetch("https://ok.example/b"))\ntry:\n    fetch("https://gone.example/c")\n'
                'except RuntimeError as e:\n    print("failed:", str(e)[:28])\n'
                'write("@answer", "Long answer. See https://ok.example/a, https://ok.example/b,\\n'
                'https://gone.example/c, `https://ok.example/b` and (https://never.example/x).")\ndone("short summary")')
        self.api.replies = [script(body)]
        out, sid = self.run_ok("--web", "research this")
        self.assertEqual(self.output(sid, 1), "https://ok.example/a T ['date', 'summary', 'title', 'url']\n"
                                              "# Page B\n\nBody of B.\nfailed: fetch failed: HTTP 404 {\"err\n")
        self.assertTrue(out.splitlines()[0].endswith(" · search 1 · fetch 2"))
        self.assertIn("answer:  Long answer. See https://ok.example/a,", out)
        self.assertIn("sources: 4 cited, 2 unverified: https://gone.example/c https://never.example/x\n", out)
        self.assertIn("(https://never.example/x).\n", self.dsk("show", sid, "--answer")[1])
        search = next(r for r in self.api.requests if r["path"] == "/v1/tools/search")
        self.assertEqual((json.loads(search["raw"]), search["key"]), ({"query": "deepseek cache", "count": 5}, "Bearer sk-fake-search"))
        self.assertIn("web: on", self.api.bodies()[0]["messages"][1]["content"])

    def test_cited_urls_that_were_all_opened(self):
        self.api.pages = {"https://ok.example/b": {"title": "B", "content": "Body."}}
        self.api.replies = [script('print(fetch("https://ok.example/b")[:3])'),
                            script('print(fetch("https://ok.example/b")[3:])\ndone("It says Body (https://ok.example/b).")')]
        out, sid = self.run_ok("--web", "research this")
        self.assertIn("sources: 1 cited, all opened in this session\n", out)
        self.assertEqual((self.output(sid, 1), self.output(sid, 2)), ("# B\n", "\n\nBody.\n"))
        self.assertEqual(sum(r["path"] == "/v1/tools/fetch" for r in self.api.requests), 1)  # the second read is not billed
        self.assertTrue(out.splitlines()[0].endswith(" · fetch 1"))

    def test_raw_search_and_fetch(self):
        self.api.search_results = [{"title": "T", "url": "https://ok.example/a", "date": None, "summary": "S"}] * 3
        self.api.pages = {"https://ok.example/b": {"title": "Page B", "content": "Body of B."}}
        self.assertEqual(self.dsk("search", "a query", "--count", "2")[:2],
                         (0, "1. T\n   https://ok.example/a · undated\n   S\n2. T\n   https://ok.example/a · undated\n   S\n"))
        self.assertEqual(self.dsk("fetch", "https://ok.example/b")[:2], (0, "# Page B\n\nBody of B.\n"))
        code, out, _ = self.dsk("fetch", "https://gone.example/c")
        self.assertEqual((code, out[:32]), (1, "dsk · error: fetch: HTTP 404 {\"e"))
        self.assertEqual(self.api.chats(), [])

    def test_sigterm_ends_the_run_as_error_and_leaves_nothing_running(self):
        self.api.replies = [script('print("going", flush=True)\nsh("sleep 49.871")')]
        proc = subprocess.Popen([sys.executable, DSK, "run", "sleepy"], cwd=self.tmp, env=self.env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.wait_for("sleep 49.871")
        proc.terminate()
        out, _ = proc.communicate(timeout=30)
        self.assertEqual(proc.returncode, 1, out)
        self.assertIn("error:   interrupted\n", out)
        self.assertEqual(subprocess.run(["pgrep", "-f", "sleep 49.871"], capture_output=True).returncode, 1)

    def test_an_interrupted_script_is_still_charged_for_what_it_did(self):
        work = 'sh("echo stray > src/stray.py; echo n > tests/new.py; sleep 49.875")'
        for kill in ("terminate", "kill"):
            repo = self.repo({"src/a.py": "a = 1\n", "tests/t.py": "t = 1\n"})
            self.api.replies = [script(work)]
            proc = subprocess.Popen([sys.executable, DSK, "run", "--allow", "tests/**", "edit"], cwd=repo, env=self.env,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.wait_for("sleep 49.875")
            getattr(proc, kill)()
            out, _ = proc.communicate(timeout=30)
            subprocess.run(["pkill", "-f", "sleep 49.875"])
            sid = next(d for d in os.listdir(f"{self.tmp}/state/dsk") if os.path.exists(f"{self.tmp}/state/dsk/{d}/log.jsonl")
                       and dsk.Session(d).head["root"] == repo)
            if kill == "terminate":
                self.assertIn("error:   interrupted\n", out)
                self.assertIn("scope:   reverted src/stray.py (copies in ", out)
                self.assertIn("changed: tests/new.py (+1)\n", out)
                self.assertFalse(os.path.exists(f"{repo}/src/stray.py"))
            self.assertEqual(self.dsk("reject", sid, "--drop", cwd=repo)[0], 0, kill)
            self.assertEqual((sorted(os.listdir(f"{repo}/src")), sorted(os.listdir(f"{repo}/tests"))), (["a.py"], ["t.py"]), kill)
            self.assertEqual(self.cat(self.tmp, "state/dsk", sid, "reverted/src/stray.py"), "stray\n")

    def wait_for(self, pattern):
        for _ in range(200):
            if subprocess.run(["pgrep", "-f", pattern], capture_output=True).returncode == 0:
                return
            __import__("time").sleep(0.05)
        self.fail(f"{pattern} never started")

    def test_a_killed_run_shows_as_error_and_can_be_dropped(self):
        self.api.replies = [script('sh("sleep 3.871")')]
        proc = subprocess.Popen([sys.executable, DSK, "run", "doomed"], cwd=self.tmp, env=self.env,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.wait_for("sleep 3.871")
        proc.kill()
        proc.communicate(timeout=30)
        sid = os.listdir(f"{self.tmp}/state/dsk")[0]
        self.assertRegex(self.dsk("status")[1], rf"^dsk {sid} · error · ")
        self.assertIn("error:   interrupted: its dsk process is gone\n", self.dsk("show", sid)[1])
        self.assertEqual(self.dsk("reject", sid, "--drop")[0], 0)
        self.assertIn("error:   interrupted: its dsk process was killed\n", self.dsk("show", sid)[1].replace("dropped", "error"))

    def test_doctor_checks_a_profile_and_reports_a_missing_key(self):
        self.api.search_results = [{"title": "T", "url": "https://ok.example/a", "date": None, "summary": "S"}]
        self.api.replies = [script("print(1)")] * 3 + [script("print(2)"), script("done('ok')")]
        code, out, _ = self.dsk("doctor", "--profile", "a")
        lines = out.splitlines()
        self.assertEqual((code, lines[0]), (0, f"dsk doctor · a · {self.api.url}/a · model-a"))
        self.assertEqual(lines[1:4], ["key:      KEY_A works, model accepted", "thinking: off is honoured",
                                      "replies:  5 of 5 are one well-formed run_code call"])
        self.assertRegex(lines[4], r"^cache:    prompt_cache_hit_tokens · same request three times: 0/\d+, (\d+)/\1, (\d+)/\2 · extended: ")
        self.assertEqual(lines[5:], ["settings: caching works, compact_at 32000 is fine", "search:   works"])
        first, second, third, fourth = (r["raw"] for r in self.api.chats()[:4])
        self.assertTrue(first == second == third != fourth)
        self.env["KEY_B"] = ""
        code, out, _ = self.dsk("doctor", "--profile", "b")
        self.assertEqual((code, out.splitlines()[1]), (1, "key:      KEY_B is not set"))


if __name__ == "__main__":
    unittest.main()
