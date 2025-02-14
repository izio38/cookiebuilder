import { IProtocol } from "@/extractor";
import { ID2Class } from "@/extractor/classes";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  cleanNamespace,
  getDefaultInitValue,
  getRealType,
  mkdirRecursive
} from "./utils";

export function buildMessages(protocol: IProtocol, path: string) {
  const importsIndex: string[] = [];
  const exportsIndex: string[] = [];
  const importsMessageReceiver: string[] = [
    `import { CustomDataWrapper } from "@dofus/network/CustomDataWrapper";`,
    `import { INetworkMessage } from "@dofus/network/INetworkMessage";`,
    `import Messages from "@dofus/network/messages";`,
    "",
    "export class MessageReceiver {",
    "  public static parse(",
    "    wrapper: CustomDataWrapper,",
    "    id: number",
    `  ): INetworkMessage {`,
    "    const messageTmp = MessageReceiver.list[id];",
    "    if (!messageTmp) {",
    `      throw new Error("Message with id " + id + " is unknown.");`,
    "    }",
    "    const message = messageTmp();",
    "    message.unpack(wrapper);",
    "    return message;",
    "  }",
    "",
    "  private static list: { [idx: number]: () => INetworkMessage } = {"
  ];
  const entriesMessageReceiver: string[] = [];
  const endMessageReceiver = ["  };", "}\n"];
  exportsIndex.push("export default {");
  for (const m of protocol.messages) {
    const clean = cleanNamespace(m.package);
    importsIndex.push(`import { ${m.name} } from "@${clean}/${m.name}";`);
    entriesMessageReceiver.push(
      `    ${m.protocolId}: () => new Messages.${m.name}(),`
    );
    exportsIndex.push(`  ${m.name},`);
    const folderPath = join(path, clean);
    mkdirRecursive(folderPath);

    const importsFile: string[] = [
      `import ByteArray from "@utils/ByteArray";`,
      `import { CustomDataWrapper } from "@dofus/network/CustomDataWrapper";`,
      `import { ICustomDataInput } from "@dofus/network/ICustomDataInput";`,
      `import { ICustomDataOutput } from "@dofus/network/ICustomDataOutput";`,
      `import { INetworkMessage } from "@dofus/network/INetworkMessage";`,
      `import { NetworkMessage } from "@dofus/network/NetworkMessage";`
    ];

    if (m.parent !== "") {
      const parent = protocol.messages.find(ty => ty.name === m.parent)!;
      const cleanNs = cleanNamespace(parent.package);
      importsFile.push(
        `import { ${m.parent} } from "@${cleanNs}/${m.parent}";`
      );
    }

    const head = [
      `export class ${m.name} ${
        m.parent !== "" ? `extends ${m.parent}` : "extends NetworkMessage"
      } implements INetworkMessage {`
    ];

    const bottom = ["}\n"];

    const body = buildMessage(protocol, m, importsFile);
    const all = importsFile.concat([""], head, body, bottom).join("\n");

    const filePath = join(folderPath, `${m.name}.ts`);
    // console.log(`Writing Message: ${filePath} ...`);
    writeFileSync(filePath, all);
  }
  const lastExport = exportsIndex.pop()!;
  exportsIndex.push(lastExport.slice(0, -1));
  const lastExportMessageReceiver = entriesMessageReceiver.pop()!;
  entriesMessageReceiver.push(lastExportMessageReceiver.slice(0, -1));
  exportsIndex.push(`};\n`);
  writeFileSync(
    join(path, "./dofus/network/messages/index.ts"),
    importsIndex.concat(["\n"], exportsIndex).join("\n")
  );
  writeFileSync(
    join(path, "./dofus/network/MessageReceiver.ts"),
    importsMessageReceiver
      .concat(entriesMessageReceiver, endMessageReceiver)
      .join("\n")
  );
}

function buildMessage(
  protocol: IProtocol,
  m: ID2Class,
  imports: string[]
): string[] {
  const data: string[] = [];
  data.push(`  public static readonly ID: number = ${m.protocolId};`);

  if (m.fields.length > 0) {
    data.push("");
  }

  let bbw = m.fields.filter(f => f.useBBW);
  const others = m.fields.filter(f => !f.useBBW);

  const resetBody: string[] = [];
  const serializeBody: string[] = [];
  const deserializeBody: string[] = [];

  if (m.parent !== "") {
    resetBody.push("    super.reset();");
    serializeBody.push("    super.serialize(writer);");
    deserializeBody.push("    super.deserialize(reader);");
  }

  if (bbw.length > 0) {
    imports.push(
      `import { BooleanByteWrapper } from "@dofus/network/utils/BooleanByteWrapper";`
    );
    bbw = bbw.sort((a, b) => a.bbwPosition! - b.bbwPosition!);
    for (const b of bbw) {
      data.push(`  public ${b.name}: boolean = false;`);
      resetBody.push(`    this.${b.name} = false;`);
      serializeBody.push(
        `    writer.writeByte(BooleanByteWrapper.setFlag(this.${b.name}, ${
          b.bbwPosition
        }));`
      );
      deserializeBody.push(
        `    this.${b.name} = BooleanByteWrapper.getFlag(reader.readByte(), ${
          b.bbwPosition
        });`
      );
    }
  }

  const usedImports: Map<string, string> = new Map();
  let protocolTypeManagerAlreadyImported = false;

  for (const o of others) {
    let realType = getRealType(o.type);
    let initValue = getDefaultInitValue(realType);
    const isCustomType = realType === "";
    if (isCustomType) {
      const alreadyImported = usedImports.has(o.type);
      if (!alreadyImported) {
        const type = protocol.types.find(ty => ty.name === o.type)!;
        const cleanNs = cleanNamespace(type.package);

        imports.push(`import { ${o.type} } from "@${cleanNs}/${o.type}";`);
        usedImports.set(o.type, "ALREADY");
      }
      realType = o.type;
      initValue = `new ${o.type}()`;
    }
    if (o.isVector) {
      realType += "[]";
      initValue = "[]";
    }
    data.push(`  public ${o.name}: ${realType} = ${initValue};`);
    resetBody.push(`    this.${o.name} = ${initValue};`);

    if (o.useTypeManager && !protocolTypeManagerAlreadyImported) {
      imports.push(
        `import { ProtocolTypeManager } from "@dofus/network/ProtocolTypeManager";`
      );
      protocolTypeManagerAlreadyImported = true;
    }

    if (o.isVector) {
      serializeBody.push(`    writer.writeShort(this.${o.name}.length);`);
      deserializeBody.push(
        `    const ${o.name}Length = reader.readUnsignedShort();`
      );
      if (o.useTypeManager || isCustomType) {
        serializeBody.push(
          `    for (const e of this.${o.name}) {`,
          `      writer.writeShort(e.getTypeId());`,
          `      e.serialize(writer);`,
          `    }`
        );
        if (o.useTypeManager) {
          deserializeBody.push(
            `    for (let i = 0; i < ${o.name}Length; i++) {`,
            `      const e = ProtocolTypeManager.getInstance(reader.readUnsignedShort());`,
            `      e.deserialize(reader);`,
            `      this.${o.name}.push(e);`,
            `    }`
          );
        } else {
          deserializeBody.push(
            `    for (let i = 0; i < ${o.name}Length; i++) {`,
            `      const e = new ${o.type}();`,
            `      e.deserialize(reader);`,
            `      this.${o.name}.push(e);`,
            `    }`
          );
        }
      } else {
        serializeBody.push(
          `    for (const e of this.${o.name}) {`,
          `      writer.${o.writeMethod}(e);`,
          `    }`
        );
        deserializeBody.push(
          `    for (let i = 0; i < ${o.name}Length; i++) {`,
          `      this.${o.name}.push(reader.${o.writeMethod &&
            o.writeMethod.replace("write", "read")}());`,
          `    }`
        );
      }
    } else {
      if (o.useTypeManager) {
        serializeBody.push(`    this.${o.name}.serialize(writer);`);
        deserializeBody.push(
          `    this.${
            o.name
          } = ProtocolTypeManager.getInstance(reader.readUnsignedShort());`
        );
        deserializeBody.push(`    this.${o.name}.deserialize(reader);`);
      } else {
        if (isCustomType) {
          serializeBody.push(`    this.${o.name}.serialize(writer);`);
          deserializeBody.push(`    this.${o.name} = new ${o.type}();`);
          deserializeBody.push(`    this.${o.name}.deserialize(reader);`);
        } else {
          serializeBody.push(`    writer.${o.writeMethod}(this.${o.name});`);
          deserializeBody.push(
            `    this.${o.name} = reader.${
              o.writeMethod
                ? o.writeMethod.replace("write", "read")
                : `${o.method}`
            }();`
          );
        }
      }
    }
  }

  data.push(
    "",
    "  public getMessageId(): number {",
    `    return ${m.name}.ID;`,
    "  }"
  );

  data.push("", "  public reset(): void {");
  if (resetBody.length === 0) {
    resetBody.push("    //");
  }
  data.push(...resetBody);
  data.push("  }");

  data.push(
    "",
    "  public pack(param1: ICustomDataOutput): void {",
    `    const loc2 = new ByteArray();`,
    `    this.serialize(new CustomDataWrapper(loc2));`,
    `    NetworkMessage.writePacket(param1, this.getMessageId(), loc2);`,
    "  }"
  );

  data.push(
    "",
    "  public unpack(param1: ICustomDataInput): void {",
    `    this.deserialize(param1);`,
    "  }"
  );

  data.push("", "  public serialize(writer: ICustomDataOutput): void {");
  if (serializeBody.length === 0) {
    serializeBody.push("    //");
  }
  data.push(...serializeBody);
  data.push("  }");

  data.push("", "  public deserialize(reader: ICustomDataInput): void {");
  if (deserializeBody.length === 0) {
    deserializeBody.push("    //");
  }
  data.push(...deserializeBody);
  data.push("  }");

  return data;
}
