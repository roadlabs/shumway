/* -*- mode: javascript; tab-width: 4; insert-tabs-mode: nil; indent-tabs-mode: nil -*- */

var AbcStream = (function () {
    function abcStream(bytes) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer);
        this.pos = 0;
    }

    abcStream.prototype = {
        get position() {
            return this.pos;
        },
        remaining: function () {
            return this.bytes.length - this.pos;
        },
        seek: function(pos) {
            this.pos = pos;
        },
        readU8: function() {
            return this.bytes[this.pos++];
        },
        readU32: function() {
            return this.readS32() >>> 0;
        },
        readU30: function() {
            var result = this.readU32();
            if (result & 0xc0000000) {
                error("Corrupt ABC File");
            }
            return result;
        },
        readU30Unsafe: function() {
            return this.readU32();
        },
        /**
         * Read a variable-length encoded 32-bit signed integer. The value may use one to five bytes (little endian), 
         * each contributing 7 bits. The most significant bit of each byte indicates that the next byte is part of
         * the value. The spec indicates that the most significant bit of the last byte to be read is sign extended
         * but this turns out not to be the case in the real implementation, for instance 0x7f should technically be
         * -1, but instead it's 127. Moreover, what happens to the remaining 4 high bits of the fifth byte that is
         * read? Who knows, here we'll just stay true to the Tamarin implementation.
         */
        readS32: function() {
            var result = this.readU8();
            if (result & 0x80) {
                result = result & 0x7f | this.readU8() << 7;
                if (result & 0x4000) {
                    result = result & 0x3fff | this.readU8() << 14;
                    if (result & 0x200000) {
                        result = result & 0x1fffff | this.readU8() << 21;
                        if (result & 0x10000000) {
                            result = result & 0x0fffffff | this.readU8() << 28;
                            result = result & 0xffffffff;
                        }
                    }
                }
            }
            return result;
        },
        readWord: function() {
            var result = this.view.getUint32(this.pos, true);
            this.pos += 4;
            return result;
        },
        readS24: function() {
            var u = this.readU8() |
                (this.readU8() << 8) |
                (this.readU8() << 16);
            return (u << 8) >> 8;
        },
        readDouble: function() {
            var result = this.view.getFloat64(this.pos, true);
            this.pos += 8;
            return result;
        },
        readUTFString: function(length) {
            var result = "", end = this.pos + length;
            
            while(this.pos < end) {
                var c = this.bytes[this.pos++];
                if (c <= 0x7f) {
                    result += String.fromCharCode(c);
                }
                else if (c >= 0xc0) { // multibyte
                    var code;
                    if (c < 0xe0) { // 2 bytes
                        code = ((c & 0x1f) << 6) |
                            (this.bytes[this.pos++] & 0x3f);
                    }
                    else if (c < 0xf0) { // 3 bytes
                        code = ((c & 0x0f) << 12) |
                            ((this.bytes[this.pos++] & 0x3f) << 6) |
                            (this.bytes[this.pos++] & 0x3f);
                    } else { // 4 bytes
                        // turned into two characters in JS as surrogate pair
                        code = (((c & 0x07) << 18) |
                                ((this.bytes[this.pos++] & 0x3f) << 12) |
                                ((this.bytes[this.pos++] & 0x3f) << 6) |
                                (this.bytes[this.pos++] & 0x3f)) - 0x10000;
                        // High surrogate
                        result += String.fromCharCode(((code & 0xffc00) >>> 10) + 0xd800);
                        // Low surrogate
                        code = (code & 0x3ff) + 0xdc00;
                    }
                    result += String.fromCharCode(code);
                } // Otherwise it's an invalid UTF8, skipped.
            }
            return result;
        }
    };

    return abcStream;
})();


function parseTraits(constantPool, stream, methods, classes) {
    var count = stream.readU30();
    var traits = [];
    for (var i = 0; i < count; i++) {
        traits.push(new Trait(constantPool, stream, methods, classes));
    }
    return traits;
}

var Trait = (function () {
    function trait(constantPool, stream, methods, classes) {
        this.name = constantPool.multinames[stream.readU30()];
        assert(this.name.isQName());
        
        var tag = stream.readU8();
        
        this.kind = tag & 0x0F;
        this.attributes = (tag >> 4) & 0x0F;

        switch (this.kind) {
            case TRAIT_Slot:
            case TRAIT_Const:
                this.slotId = stream.readU30();
                this.typeName = constantPool.multinames[stream.readU30()];
                var valueIndex = stream.readU30();
                this.value = null;
                if (valueIndex != 0) {
                    this.value = constantPool.getValue(stream.readU8(), valueIndex);
                }
                break;
            case TRAIT_Method:
            case TRAIT_Setter:
            case TRAIT_Getter:
                this.dispId = stream.readU30();
                this.method = methods[stream.readU30()];
                break;
            case TRAIT_Class:
                this.slotId = stream.readU30();
                assert(classes, "Classes should be passed down here, I'm guessing whenever classes are being parsed.");
                this.class = classes[stream.readU30()];
                break;
            case TRAIT_Function: // TODO
                this.slotId = stream.readU30();
                this.method = methods[stream.readU30()];
                break;
        }

        if (this.attributes & ATTR_Metadata) {
            var metadata = [];
            var metadatacount = stream.readU30();
            for (var i = 0; i < metadatacount; ++i)
                metadata.push(stream.readU30());
            this.metadata = metadata;
        }
    }
    
    trait.prototype.toString = function toString() {
        var str = getFlags(this.attributes, "final|override|metadata".split("|")) + " " + this.name;
        switch (this.kind) {
            case TRAIT_Slot:
            case TRAIT_Const:
                return str + ", slotId: " + this.slotId + ", typeName: " + this.typeName + ", value: " + this.value;
            case TRAIT_Method:
            case TRAIT_Setter:
            case TRAIT_Getter:
                return str + ", method: " + this.method + ", dispId: " + this.dispId;
                break;
            case TRAIT_Class:
                return str + ", slotId: " + this.slotId + ", class: " + this.class;
                break;
            case TRAIT_Function: // TODO
                break;
        }
    }
    
//        trait.prototype.find = function find(multiname) {
//            var traits = this.traits;
//            for (var i = 0; i < traits.length; i++) {
//                if (traits[i].name.matches(multiname)) {
//                    return traits[i];
//                }
//            }
//            return null;
//        };
    
    return trait;
})();

var Namespace = (function () {
    
    const PUBLIC             = 0x00;
    const PROTECTED          = 0x01;
    const PACKAGE_INTERNAL   = 0x02;
    const PRIVATE            = 0x04;
    const EXPLICIT           = 0x08;
    const STATIC_PROTECTED   = 0x10;
    
    function namespace(constantPool, stream) {
        this.kind = stream.readU8();
        
        var index = stream.readU30();
        
        switch(this.kind) {
            case CONSTANT_Namespace:
            case CONSTANT_PackageNamespace:
            case CONSTANT_PackageInternalNs:
            case CONSTANT_ProtectedNamespace:
            case CONSTANT_ExplicitNamespace:
            case CONSTANT_StaticProtectedNs:
                this.type = PUBLIC;
                switch(this.kind) {
                    case CONSTANT_PackageInternalNs:
                        this.type = PACKAGE_INTERNAL;
                        break;
                    case CONSTANT_ProtectedNamespace:
                        this.type = PROTECTED;
                        break;
                    case CONSTANT_ExplicitNamespace:
                        this.type = EXPLICIT;
                        break;
                    case CONSTANT_StaticProtectedNs:
                        this.type = STATIC_PROTECTED;
                        break;
                }
                this.name = constantPool.strings[index];
                
                break;
            case CONSTANT_PrivateNs:
                this.type = PRIVATE;
                this.name = constantPool.strings[index];
                break;
            default:
                unexpected();
        }
    }
    
    namespace.prototype.isPublic = function isPublic() {
        // TODO: Broken
        return this.type == PUBLIC; 
    };
    
    namespace.prototype.getURI = function getURI() {
        // TODO: Broken
        return this.name; 
    };
    
    namespace.prototype.toString = function toString() {
        if (this.type == PRIVATE) {
            return "private";
        }
        return this.name;
    }
    
    return namespace;
})();

/**
 * Section 2.3 and 4.4.3
 * 
 * There are 10 multiname types, those ending in "A" represent the names of attributes. Some multinames
 * have the name and/or namespace part resolved at runtime, and are referred to as runtime multinames.
 * 
 *  QName[A] - A qualified name is the simplest form of multiname, it has a name with exactly one
 *    namespace. They are usually used to represent the names of variables and for type annotations.
 *              
 *  RTQName[A] - A runtime qualified name is a QName whose runtime part is resolved at runtime. Whenever
 *    a RTQName is used as an operand for an instruction, the namespace part is expected to be on the stack. 
 *    RTQNames are used when the namespace is not known at compile time.
 *    ex: getNamespace()::f
 *  
 *  RTQNameL[A] - A runtime qualified name late is a QName whose name and runtime part are resolved at runtime.
 *    ex: getNamespace()::[getName()]
 *                 
 *  Multiname[A] - A multiple namespace name is a name with a namespace set. The namespace set represents
 *  a collection of namespaces. Multinames are used for unqualified names where multiple namespace may be open.
 *    ex: f
 *                 
 *  MultinameL[A] - A multiname where the name is resolved at runtime.
 *    ex: [f]
 *  
 *  Multiname Resolution: Section 2.3.6 
 *  
 *    Multinames are resolved in the object's declared traits, its dynamic properties, and finally the 
 *    prototype chain, in this order, unless otherwise noted. The last two only happen if the multiname 
 *    contains the public namespace (dynamic properties are always in the public namespace).
 *    
 *    If the multiname is any type of QName, the QName will resolve to the property with the same name and
 *    namespace as the QName. If no property has the same name and namespace then the QName is unresolved.
 *    
 *    If the multiname has a namespace set, then the object is searched for any properties with the same
 *    name and a namespace matches any of the namespaces in the namespace set.
 */
var Multiname = (function () {
    const ATTRIBUTE          = 0x01;
    const QNAME              = 0x02;
    const RUNTIME_NAMESPACE  = 0x04;
    const RUNTIME_NAME       = 0x08;
    const NAMESPACE_SET      = 0x10;
    const TYPE_PARAMETER     = 0x20;
    
    function multiname() {
        
    }
    
    multiname.prototype.clone = function clone() {
        var clone = new multiname();
        clone.flags = this.flags;
        clone.name = this.name;
        clone.namespace = this.namespace;
        clone.namespaceSet = this.namespaceSet;
        clone.typeParameter = this.typeParameter;
        return clone;
    }
    
    multiname.prototype.parse = function parse(constantPool, stream, multinames) {
        var index = 0;
        this.flags = 0;
        this.kind = stream.readU8();
        
        var setAnyNamespace = function() {
            this.flags &= ~(NAMESPACE_SET | RUNTIME_NAMESPACE); 
            this.namespace = null;
        }.bind(this);
        
        var setAnyName = function() {
            this.flags &= ~(RUNTIME_NAME); 
            this.name = null;
        }.bind(this);
        
        var setQName = function() {
            this.flags |= QNAME;
        }.bind(this);
        
        var setAttribute = function(set) {
            if (set) {
                this.flags |= ATTRIBUTE;
            } else {
                this.flags &= ~(ATTRIBUTE);
            }
        }.bind(this);
        
        var setRuntimeName = function() {
            this.flags |= RUNTIME_NAME;
            this.name = null;
        }.bind(this);
        
        var setRuntimeNamespace = function() {
            this.flags |= RUNTIME_NAMESPACE;
            this.flags &= ~(NAMESPACE_SET);
            this.namespace = null;
        }.bind(this);
        
        var setNamespaceSet = function(namespaceSet) {
            assert(namespaceSet != null);
            this.flags &= ~(RUNTIME_NAMESPACE);
            this.flags |= NAMESPACE_SET;
            this.namespaceSet = namespaceSet;
        }.bind(this);
        
        var setTypeParameter = function(typeParameter) {
            this.flags |= TYPE_PARAMETER;
            this.typeParameter = typeParameter;
        }.bind(this);
        
        switch (this.kind) {
            case CONSTANT_QName: case CONSTANT_QNameA:
                index = stream.readU30();
                if (index == 0) {
                    setAnyNamespace();
                } else {
                    this.namespace = constantPool.namespaces[index]; 
                }
                index = stream.readU30();
                if (index == 0) {
                    setAnyName();
                } else {
                    this.name = constantPool.strings[index];
                }
                setQName();
                setAttribute(this.kind == CONSTANT_QNameA);
                break;
            case CONSTANT_RTQName: case CONSTANT_RTQNameA:
                index = stream.readU30();
                if (index == 0) {
                    setAnyName();
                } else {
                    this.name = constantPool.strings[index];
                }
                setQName();
                setRuntimeNamespace();
                setAttribute(this.kind == CONSTANT_RTQNameA);
                break;
            case CONSTANT_RTQNameL: case CONSTANT_RTQNameLA:
                setQName();
                setRuntimeNamespace();
                setRuntimeName();
                setAttribute(this.kind == CONSTANT_RTQNameLA);
                break;
            case CONSTANT_Multiname: case CONSTANT_MultinameA:
                index = stream.readU30();
                if (index == 0) {
                    setAnyName();
                } else {
                    this.name = constantPool.strings[index];
                }
                index = stream.readU30();
                assert(index != 0);
                setNamespaceSet(constantPool.namespaceSets[index]);
                setAttribute(this.kind == CONSTANT_MultinameA);
                break;
            case CONSTANT_MultinameL: case CONSTANT_MultinameLA:
                setRuntimeName();
                index = stream.readU30();
                assert(index != 0);
                setNamespaceSet(constantPool.namespaceSets[index]);
                setAttribute(this.kind == CONSTANT_MultinameLA);
                break;
            /**
             * This is undocumented, looking at Tamarin source for this one.
             */
            case CONSTANT_TypeName:
                index = stream.readU32();
                for (var key in multinames[index]) {
                    this[key] = multinames[index][key];
                }
                index = stream.readU32();
                assert(index == 1);
                setTypeParameter(stream.readU32());
                break;
            default:
                unexpected();
                break;
        }
    };
    
    multiname.prototype.isAttribute = function isAttribute() {
        return this.flags & ATTRIBUTE;
    };
    
    multiname.prototype.isAnyName = function isAnyName() {
        return !this.isRuntimeName() && this.name == null;
    };
    
    multiname.prototype.isAnyNamespace = function isAnyNamespace() {
        return !this.isRuntimeNamespace() && !(this.flags & NAMESPACE_SET) && this.namespace == null;
    };
    
    multiname.prototype.isRuntimeName = function isRuntimeName() {
        return this.flags & RUNTIME_NAME;
    };
    
    multiname.prototype.isRuntimeNamespace = function isRuntimeNamespace() {
        return this.flags & RUNTIME_NAMESPACE;
    };
    
    multiname.prototype.isRuntime = function isRuntime() {
        return this.flags & (RUNTIME_NAME | RUNTIME_NAMESPACE);
    }
    
    multiname.prototype.isQName = function isQName() {
        return this.flags & QNAME;
    };
    
    multiname.prototype.namespaceCount = function namespaceCount() {
        return (this.namespaceSet && (this.flags & NAMESPACE_SET)) ? this.namespaceSet.length : 1; 
    };
    
    multiname.prototype.getName = function getName() {
        assert(!this.isAnyName() && !this.isRuntimeName());
        return this.name;
    };
    
    multiname.prototype.setName = function setName(name) {
        this.flags &= ~(RUNTIME_NAME);
        this.name = name;
    };
    
    multiname.prototype.getNamespace = function getNamespace(i) {
        assert(!this.isRuntimeNamespace() && !this.isAnyNamespace());
        if (this.flags & NAMESPACE_SET) {
            return this.namespaceSet != null ? this.namespaceSet[i] : null;
        } else {
            assert(i == 0);
            return this.namespace;
        }
    };
    
    multiname.prototype.matches = function matches(multiname) {
        assert(this.isQName() && !this.isRuntime());
        if (this.name != multiname.name) {
            return false;
        }
        if (multiname.namespace) {
            return this.namespace == multiname.namespace;
        } else {
            return multiname.namespaceSet.indexOf(this.namespace) >= 0;
        }
        return this.name;
    };
    
    multiname.prototype.nameToString = function nameToString() {
        if (this.isAnyName()) {
            return "*";
        } else {
            return this.isRuntimeName() ? "[]" : this.getName();
        }
    };
    
    multiname.prototype.toString = function toString() {
        var str = this.isAttribute() ? "@" : "";
        if (this.isAnyNamespace()) {
            str += "*::" + this.nameToString();
        } else if (this.isRuntimeNamespace()) {
            str += "[]::" + this.nameToString();
        } else if (this.namespaceCount() == 1 && this.isQName()) {
            str += this.namespace + "::";
            str += this.nameToString();
        } else {
            str += "{";
            for (var i = 0, count = this.namespaceCount(); i < count; i++) {
                str += this.getNamespace(i);
                if (i + 1 < count) {
                    str += ",";
                }
            }
            str += "}::" + this.nameToString();
        }
        return str;
    }
    
    return multiname;
})();

var ConstantPool = (function constantPool() {
    function constantPool(stream) {
        var i, n;

        // ints
        var ints = [0];
        n = stream.readU30();
        for (i = 1; i < n; ++i) {
            ints.push(stream.readS32());
        }

        // uints
        var uints = [0];
        n = stream.readU30();
        for (i = 1; i < n; ++i) {
            uints.push(stream.readU32());
        }

        // doubles
        var doubles = [NaN];
        n = stream.readU30();
        for (i = 1; i < n; ++i) {
            doubles.push(stream.readDouble());
        }

        // strings
        var strings = [""];
        n = stream.readU30();
        for (i = 1; i < n; ++i) {
            strings.push(stream.readUTFString(stream.readU30()));
        }

        this.ints = ints;
        this.uints = uints;
        this.doubles = doubles;
        this.strings = strings;
        
        // namespaces
        var namespaces = [undefined];
        n = stream.readU30();
        for (i = 1; i < n; ++i) {
            namespaces.push(new Namespace(this, stream));
        }

        // namespace sets
        var namespaceSets = [undefined];
        n = stream.readU30();
        for (i = 1; i < n; ++i) {
            var count = stream.readU30();
            var set = [];
            for (var j = 0; j < count; ++j) {
                set.push(namespaces[stream.readU30()]);
            }
            namespaceSets.push(set);
        }

        
        this.namespaces = namespaces;
        this.namespaceSets = namespaceSets;
        
        // multinames
        var multinames = [undefined];
        n = stream.readU30();
        for (i = 1; i < n; ++i) {
            var multiname = new Multiname(this, stream, multinames);
            multiname.parse(this, stream, multinames);
            multinames.push(multiname);
        }
        
        this.multinames = multinames;
    }
    
    constantPool.prototype.getValue = function getValue(kind, index) {
        switch (kind) {
        case CONSTANT_Int: 
            return this.ints[index];
        case CONSTANT_UInt: 
            return this.uints[index];
        case CONSTANT_Double: 
            return this.doubles[index];
        case CONSTANT_Utf8: 
            return this.strings[index];
        case CONSTANT_True: 
            return true;
        case CONSTANT_False: 
            return false;
        case CONSTANT_Null: 
            return null;
        case CONSTANT_Undefined: 
            return undefined;
        case CONSTANT_Namespace:
        case CONSTANT_PackageInternalNS:
            return this.namespaces[index];
        case CONSTANT_QName:
        case CONSTANT_MultinameA:
        case CONSTANT_RTQName:
        case CONSTANT_RTQNameA:
        case CONSTANT_RTQNameL:
        case CONSTANT_RTQNameLA:
        case CONSTANT_NameL:
        case CONSTANT_NameLA:
            return this.multinames[index];
        case CONSTANT_Float: 
            warning("TODO: CONSTANT_Float may be deprecated?");
            break;
        default: 
            assert(false, "Not Implemented Kind " + kind);
        }
    }; 
    
    return constantPool;
})();

var MethodInfo = (function () {
    function methodInfo(constantPool, stream) {
        var paramcount = stream.readU30();
        var returntype = stream.readU30();
        var params = [];
        for (var i = 0; i < paramcount; ++i)
            params.push(stream.readU30());

        var name = constantPool.strings[stream.readU30()];
        var flags = stream.readU8();

        var optionalcount = 0;
        var optionals = null;
        if (flags & METHOD_HasOptional) {
            optionalcount = stream.readU30();
            optionals = [];
            for (var i = 0; i < optionalcount; ++i) {
                optionals[i] = { val: stream.readU30(), kind:stream.readU8() };
            }
        }

        var paramnames = null;
        if (flags & METHOD_HasParamNames) {
            paramnames = [];
            for (var i = 0; i < paramcount; ++i) {
                paramnames[i] = constantPool.strings[stream.readU30()];
            }
        }

        this.name = name;
        this.params = params;
        this.returntype = returntype;
        this.flags = flags;
        this.optionals = optionals;
        this.paramnames = paramnames;
    }
    
    methodInfo.prototype = {
        toString: function toString() {
            var flags = getFlags(this.flags, "NEED_ARGUMENTS|NEED_ACTIVATION|NEED_REST|HAS_OPTIONAL|||SET_DXN|HAS_PARAM_NAMES".split("|"));
            return (flags ? flags + " " : "") + this.name;
        }
    };
    
    return methodInfo;
})();

var MetaDataInfo = (function () {
    function metaDataInfo(constantPool, stream) {
        var name = stream.readU30();
        var itemcount = stream.readU30();
        
        var items = [];
        for (var i = 0; i < itemcount; ++i) {
            items[i] = { key: stream.readU30(), value: stream.readU30() };
        }

        this.name = name;
        this.items = items;
    }
    return metaDataInfo;
})();

var InstanceInfo = (function () {
    function instanceInfo(constantPool, methods, stream) {
        this.name = constantPool.multinames[stream.readU30()];
        assert(this.name.isQName());
        this.superName = constantPool.multinames[stream.readU30()];
        this.flags = stream.readU8();
        this.protectedNs = 0;
        if (this.flags & 8) {
            this.protectedNs = constantPool.namespaces[stream.readU30()];
        }
        var interfaceCount = stream.readU30();
        this.interfaces = [];
        for (var i = 0; i < interfaceCount; i++) {
            this.interfaces[i] = constantPool.multinames[stream.readU30()];
        }
        this.init = methods[stream.readU30()];
        this.traits = parseTraits(constantPool, stream, methods);
    }
    instanceInfo.prototype.toString = function toString() {
        var flags = getFlags(this.flags & 8, "sealed|final|interface|protected".split("|"));
        var str = (flags ? flags + " " : "") + this.name;
        if (this.superName) {
            str += " extends " + this.superName; 
        }
        return str;
    }
    return instanceInfo;
})();

var ClassInfo = (function () {
    function classInfo(constantPool, methods, stream) {
        this.init = methods[stream.readU30()];
        this.traits = parseTraits(constantPool, stream, methods);
    }
    return classInfo;
})();

var ScriptInfo = (function scriptInfo() {
    function scriptInfo(constantPool, methods, classes, stream) {
        this.init = methods[stream.readU30()];
        this.methods = methods;
        this.traits = parseTraits(constantPool, stream, methods, classes);
    }
    scriptInfo.prototype = {
        get entryPoint() {
            return this.init;
        }
    };
    return scriptInfo;
})();

var MethodBody = (function () {
    function parseException(stream) {
        return {
            start: stream.readU30(), 
            end: stream.readU30(), 
            target: stream.readU30(),
            typename: stream.readU30(), 
            name: stream.readU30()
        };
    }
    
    function methodBody(constantPool, methods, stream) {
        this.methodInfo = methods[stream.readU30()];
        this.maxStack = stream.readU30();
        this.localCount = stream.readU30();
        this.initScopeDepth = stream.readU30();
        this.maxScopeDepth = stream.readU30();

        var code = new Uint8Array(stream.readU30());
        for (var i = 0; i < code.length; ++i) { 
            code[i] = stream.readU8();
        }
        this.code = code;

        var exceptions = [];
        var exceptionCount = stream.readU30();
        for (var i = 0; i < exceptionCount; ++i) {
            exceptions = parseException(stream);
        }
        this.exceptions = exceptions;
        this.traits = parseTraits(constantPool, stream, methods);
    }
    return methodBody;
})();

var AbcFile = (function () {
    function abcFile(bytes) {
        var n;
        var stream = new AbcStream(bytes);
        checkMagic(stream);
        this.constantPool = new ConstantPool(stream);
        
        // Method Infos
        this.methods = [];
        n = stream.readU30();
        for (i = 0; i < n; ++i) {
            this.methods.push(new MethodInfo(this.constantPool, stream));
        }
                    
        // MetaData Infos
        this.metadata = [];
        n = stream.readU30();
        for (i = 0; i < n; ++i) {
            this.metadata.push(new MetaDataInfo(this.constantPool, stream));
        }

        // Instance Infos
        this.instances = [];
        n = stream.readU30();
        for (i = 0; i < n; ++i) {
            this.instances.push(new InstanceInfo(this.constantPool, this.methods, stream));
        }

        // Class Infos
        this.classes = [];
        for (i = 0; i < n; ++i) {
            this.classes.push(new ClassInfo(this.constantPool, this.methods, stream));
        }

        // Script Infos
        this.scripts = [];
        n = stream.readU30();
        for (i = 0; i < n; ++i) {
            this.scripts.push(new ScriptInfo(this.constantPool, this.methods, this.classes, stream));
        }

        // Method Bodies
        this.methodBodies = [];
        n = stream.readU30();
        for (i = 0; i < n; ++i) {
            this.methodBodies.push(new MethodBody(this.constantPool, this.methods, stream));
        }
    }
    
    function checkMagic(stream) {
        var magic = stream.readWord();
        var flashPlayerBrannan = 46 << 16 | 15; 
        if (magic < flashPlayerBrannan) {
            throw new Error("Invalid ABC File (magic = " + Number(magic).toString(16) + ")");
        }
    }
    
    abcFile.prototype = {
        get lastScript() {
            assert (this.scripts.length > 0);
            return this.scripts[this.scripts.length - 1];
        },
        /**
         * Returns the entry point method for this Abc file. According to the spec, this is the
         * method associated with the last script in the file.
         */
        get entryPoint() {
            return this.lastScript.entryPoint;
        },
        
        sillyMethodLookup: function (methodInfo) {
            for (var key in this.methodBodies) {
                if (this.methodBodies[key].methodInfo == methodInfo) {
                    return this.methodBodies[key];
                }
            }
            return null;
        }
    };
    
    return abcFile;
})();
