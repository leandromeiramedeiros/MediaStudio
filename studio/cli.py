"""Media Studio from the terminal: the same engines the app uses. Run from the repo root.

  python -m studio.cli qwen <describe|svg|draft|digest|raw> [--image PATH]... [--file PATH|-] [--clipboard]
                            [--seed N] [--think] [--online] [--force] [--out PATH] [prompt...]
  python -m studio.cli comfy <image|video|voice|music|sfx> [--size WxH] [--image PATH] [--seconds N] [--speaker NAME]
                             [--instruct TEXT] [--lyrics TEXT] [--seed N] [--force] [prompt...]
  python -m studio.cli orchestrate [--image PATH]... [--seed N] [--animate] [--aspect 16:9|9:16|1:1] [--no-music] <request...>
  python -m studio.cli render <project.json>
  python -m studio.cli gif <video> [--start S] [--end S]
  python -m studio.cli stop qwen|comfy
  python -m studio.cli resources

Outputs go to library/<kind>/ with a .json sidecar; the path is printed, stats go to stderr.
Exit 2 = bad input, 3 = DD2 running, 4 = runtime failed to start.
"""
import json
import shutil
import sys

from .jobs import JobError

FLAGS = {"--think", "--online", "--force", "--clipboard", "--animate", "--no-music"}


def parse(argv):
    o, rest, i = {"image": []}, [], 0
    while i < len(argv):
        a = argv[i]
        if a in FLAGS:
            o[a[2:]] = True
        elif a.startswith("--"):
            if i + 1 >= len(argv):
                raise JobError(f"{a} needs a value", 2)
            if a == "--image":
                o["image"].append(argv[i + 1])
            else:
                o[a[2:]] = argv[i + 1]
            i += 1
        else:
            rest.append(a)
        i += 1
    return o, " ".join(rest)


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd, args = argv[0], argv[1:]
    if cmd == "watch":
        from . import comfy, qwen
        return (qwen if args[0] == "qwen" else comfy).watch()
    if cmd == "stop":
        from . import comfy, qwen
        return (qwen if args[0] == "qwen" else comfy).stop()
    if cmd == "resources":
        from . import resources
        print(json.dumps(resources.snapshot()))
        return 0
    if cmd == "qwen":
        from . import qwen
        preset, (o, prompt) = args[0], parse(args[1:])
        material = ""
        if o.get("file") == "-":  # stdin only on request: a background shell's stdin never closes
            material = sys.stdin.read()
        elif o.get("file"):
            with open(o["file"], encoding="utf-8", errors="replace") as f:
                material = f.read()
        if o.get("clipboard"):
            kind, value = qwen.read_clipboard()
            if kind == "image":
                o["image"].append(value)
            else:
                material = (material + "\n\n" + value) if material else value
        j = qwen.run(preset, prompt, material, o["image"], think=o.get("think", False), force=o.get("force", False),
                     seed=int(o.get("seed", qwen.DEFAULT_SEED)), online=o.get("online", False))
        if o.get("out"):
            shutil.copyfile(j["output"], o["out"])
        else:
            sys.stdout.reconfigure(encoding="utf-8")
            print(j["text"])
        print(f"[qwen {preset}: {j['prompt_tokens']} in, {j['tokens']} out, {j['tok_per_s']} tok/s, "
              f"{j['ended'] - j['started']:.0f}s{' TRUNCATED' if j['truncated'] else ''}] {j['output']}", file=sys.stderr)
        return 0
    if cmd == "comfy":
        from . import comfy
        preset, (o, prompt) = args[0], parse(args[1:])
        params = {k: o.get(k) for k in ("size", "seconds", "speaker", "instruct", "lyrics")}
        params["image"] = o["image"][0] if o["image"] else None
        j = comfy.run(preset, prompt, params, seed=o.get("seed"), force=o.get("force", False))
        print(j["output"])
        print(f"[{j['model']} {preset}: seed {j['seed']}, {j['ended'] - j['started']:.0f}s]", file=sys.stderr)
        return 0
    if cmd == "orchestrate":
        from . import orchestrate
        o, request = parse(args)
        j = orchestrate.run(request, o["image"], seed=int(o.get("seed", 42)), animate=o.get("animate", False),
                            aspect=o.get("aspect", "16:9"), music=not o.get("no-music"), effort=int(o.get("effort", 2)),
                            force=o.get("force", False))
        print(j["output"])
        print(f"[orchestrate: {len(j['plan']['shots'])} shots, {j['ended'] - j['started']:.0f}s] project {j['project']}", file=sys.stderr)
        return 0
    if cmd == "render":
        from . import media
        with open(args[0], encoding="utf-8") as f:
            print(media.render(json.load(f))["output"])
        return 0
    if cmd == "gif":
        from . import media
        o, src = parse(args)
        print(media.nexus_gif(src, start=float(o.get("start", 0)), end=float(o["end"]) if o.get("end") else None)["output"])
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]) or 0)
    except JobError as e:
        print(f"studio: {e}", file=sys.stderr)
        sys.exit(e.code)
    except KeyboardInterrupt:
        sys.exit(130)
