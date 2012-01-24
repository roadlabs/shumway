load("../util.js");
load("../avm2-runtime.js");
load("../DataView.js");
load("../constants.js");
load("../opcodes.js");
load("../parser.js");
load("../compiler.js");
load("../disassembler.js");
load("../interpreter.js");

if (arguments.length == 0) {
    printUsage();
    quit();
}

function printUsage() {
    print("avm: [-d | -x] file");
    print("      -d = Disassemble .abc file.");
    print("      -x = Execute .abc file.");
    print("      -q = Quiet.");
}

var file = arguments[arguments.length - 1];
var options = arguments.slice(0, arguments.length - 1);

var disassemble = options.indexOf("-d") >= 0;
var execute = options.indexOf("-x") >= 0;
var quiet = options.indexOf("-q") >= 0;

if (quiet) {
    traceExecution = null;
}

var abc = new AbcFile(snarf(file, "binary"));
var methodBodies = abc.methodBodies;

if (disassemble) {
    abc.trace(new IndentingWriter(false));
}

if (execute) {
    interpretAbc(abc);
}