// Micro-benchmark of the mapper bundle in the engine's Rhino 1.7.13.
//   docker run --rm -v "$PWD:/work" --entrypoint java openintegrationengine/engine:4.5.2-ubuntu-jre \
//     -cp /opt/engine/server-lib/rhino-1.7.13.jar org.mozilla.javascript.tools.shell.Main -version 200 \
//     /work/engine/test/rhino-bench.js /work
var repo = arguments[0] || '.';
var src = readFile(repo + '/mapper/dist/hub-mapper.js', 'UTF-8');
var load = new Function(src + '; return HubMapper;');
var M = load();
var raw = readFile(repo + '/testdata/golden/adt-a01-admission.hl7', 'UTF-8');
var term = new M.InMemoryTerminology([]);
function bench(label, f) {
  for (var w = 0; w < 5; w++) f();
  var t = Date.now();
  for (var i = 0; i < 50; i++) f();
  print(label + ': ' + ((Date.now() - t) / 50).toFixed(2) + ' ms');
}
bench('evaluate bundle (per script run)', function () { load(); });
bench('parseHl7 ADT^A01', function () { M.parseHl7(raw); });
bench('hash128', function () { M.hash128('KLINIKUM|KIS|G0001|Patient|https://fhir.klinikum-musterstadt.example/sid/patientennummer|4711'); });
bench('mapMessage ADT^A01', function () { M.mapMessage(raw, { terminology: term, now: 0 }); });
