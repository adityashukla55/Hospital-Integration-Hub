// Runs the committed mapper bundle in the engine's own JavaScript runtime
// (Rhino 1.7.13, language version ES6 = 200, as configured in OIE) and checks
// that every golden case produces exactly the same output as in Node.
//
//   java -cp rhino-1.7.13.jar org.mozilla.javascript.tools.shell.Main -version 200 engine/test/rhino-smoke.js <repo>
var repo = arguments[0] || '.';
load(repo + '/mapper/dist/hub-mapper.js');

function listJson(dir) {
  var files = new java.io.File(dir).listFiles();
  var out = [];
  for (var i = 0; i < files.length; i++) {
    var name = String(files[i].getName());
    if (/\.json$/.test(name)) out.push(String(files[i].getPath()));
  }
  out.sort();
  return out;
}

var maps = [];
var sources = listJson(repo + '/terminology').concat(listJson(repo + '/mapper/test/fixtures'));
for (var i = 0; i < sources.length; i++) maps.push(JSON.parse(readFile(sources[i], 'UTF-8')));
var terminology = new HubMapper.InMemoryTerminology(maps);
var NOW = Date.UTC(2026, 10, 17, 9, 0, 0);

function expected(raw) {
  var out = HubMapper.transform(raw, { terminology: terminology, now: NOW });
  if (out.status === 'MAPPED') return { status: out.status, type: out.message.type, issues: out.result.issues, bundle: out.result.bundle };
  if (out.status === 'IGNORED') return { status: out.status, type: out.message.type, reason: out.reason };
  return { status: out.status, code: out.code, message: out.message, location: out.location };
}

var failures = 0;
var checked = 0;
var dirs = ['golden', 'corpus'];
for (var d = 0; d < dirs.length; d++) {
  var dir = repo + '/testdata/' + dirs[d];
  var files = new java.io.File(dir).listFiles();
  for (var f = 0; f < files.length; f++) {
    var path = String(files[f].getPath());
    if (!/\.hl7$/.test(path)) continue;
    var actual = JSON.stringify(expected(readFile(path, 'UTF-8')));
    var want = JSON.stringify(JSON.parse(readFile(path.replace(/\.hl7$/, '.json'), 'UTF-8')));
    checked++;
    if (actual !== want) {
      failures++;
      print('MISMATCH ' + path);
    }
  }
}
print('rhino ' + org.mozilla.javascript.Context.getCurrentContext().getImplementationVersion());
print(checked + ' messages checked in Rhino, ' + failures + ' mismatches');
quit(failures ? 1 : 0);
