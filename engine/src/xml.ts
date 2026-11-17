/**
 * OIE 4.5 (Mirth Connect 4.x) channel XML fragments. Channels are generated
 * from engine/src/channels.ts so they can be reviewed as code; the XML in
 * engine/channels/ is the artifact OIE imports (and what the Administrator
 * would export). Field names follow the XStream serialisation of the
 * com.mirth.connect.* model classes.
 */

export const OIE_VERSION = '4.5.2';
const V = OIE_VERSION;

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const resourceIds = `<resourceIds class="linked-hash-map"><entry><string>Default Resource</string><string>[Default Resource]</string></entry></resourceIds>`;

function sourceProps(o: { responseVariable: string; respondAfterProcessing: boolean; threads?: number }): string {
  return `<sourceConnectorProperties version="${V}">
        <responseVariable>${esc(o.responseVariable)}</responseVariable>
        <respondAfterProcessing>${o.respondAfterProcessing}</respondAfterProcessing>
        <processBatch>false</processBatch>
        <firstResponse>false</firstResponse>
        <processingThreads>${o.threads ?? 1}</processingThreads>
        ${resourceIds}
        <queueBufferSize>1000</queueBufferSize>
      </sourceConnectorProperties>`;
}

// ---------------------------------------------------------------------------
// data types

const hl7v2Props = (tag: string) => `<${tag} class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2DataTypeProperties" version="${V}">
        <serializationProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2SerializationProperties" version="${V}">
          <handleRepetitions>true</handleRepetitions>
          <handleSubcomponents>true</handleSubcomponents>
          <useStrictParser>false</useStrictParser>
          <useStrictValidation>false</useStrictValidation>
          <stripNamespaces>true</stripNamespaces>
          <segmentDelimiter>\\r</segmentDelimiter>
          <convertLineBreaks>true</convertLineBreaks>
        </serializationProperties>
        <deserializationProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2DeserializationProperties" version="${V}">
          <useStrictParser>false</useStrictParser>
          <useStrictValidation>false</useStrictValidation>
          <segmentDelimiter>\\r</segmentDelimiter>
        </deserializationProperties>
        <batchProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2BatchProperties" version="${V}">
          <splitType>MSH_Segment</splitType>
          <batchScript></batchScript>
        </batchProperties>
        <responseGenerationProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2ResponseGenerationProperties" version="${V}">
          <segmentDelimiter>\\r</segmentDelimiter>
          <successfulACKCode>AA</successfulACKCode>
          <successfulACKMessage></successfulACKMessage>
          <errorACKCode>AE</errorACKCode>
          <errorACKMessage>An Error Occurred Processing Message.</errorACKMessage>
          <rejectedACKCode>AR</rejectedACKCode>
          <rejectedACKMessage>Message Rejected.</rejectedACKMessage>
          <msh15ACKAccept>false</msh15ACKAccept>
          <dateFormat>yyyyMMddHHmmss.SSS</dateFormat>
        </responseGenerationProperties>
        <responseValidationProperties class="com.mirth.connect.plugins.datatypes.hl7v2.HL7v2ResponseValidationProperties" version="${V}">
          <successfulACKCode>AA,CA</successfulACKCode>
          <errorACKCode>AE,CE</errorACKCode>
          <rejectedACKCode>AR,CR</rejectedACKCode>
          <validateMessageControlId>true</validateMessageControlId>
          <originalMessageControlId>Destination_Encoded</originalMessageControlId>
          <originalIdMapVariable></originalIdMapVariable>
        </responseValidationProperties>
      </${tag}>`;

const rawProps = (tag: string) => `<${tag} class="com.mirth.connect.plugins.datatypes.raw.RawDataTypeProperties" version="${V}">
        <batchProperties class="com.mirth.connect.plugins.datatypes.raw.RawBatchProperties" version="${V}">
          <splitType>JavaScript</splitType>
          <batchScript></batchScript>
        </batchProperties>
      </${tag}>`;

export type DataType = 'HL7V2' | 'RAW';

function transformer(tag: 'transformer' | 'responseTransformer', inbound: DataType, outbound: DataType): string {
  const props = (t: string, d: DataType) => (d === 'HL7V2' ? hl7v2Props(t) : rawProps(t));
  return `<${tag} version="${V}">
      <elements/>
      <inboundTemplate encoding="base64"></inboundTemplate>
      <outboundTemplate encoding="base64"></outboundTemplate>
      <inboundDataType>${inbound}</inboundDataType>
      <outboundDataType>${outbound}</outboundDataType>
      ${props('inboundProperties', inbound)}
      ${props('outboundProperties', outbound)}
    </${tag}>`;
}

const filter = `<filter version="${V}"><elements/></filter>`;

// ---------------------------------------------------------------------------
// source connectors

export interface SourceConnector {
  xml: string;
}

/** TCP Listener in MLLP mode; ACK is generated before processing (source queue on). */
export function mllpListener(port: number, dataType: DataType = 'HL7V2'): SourceConnector {
  return {
    xml: `<sourceConnector version="${V}">
    <metaDataId>0</metaDataId>
    <name>sourceConnector</name>
    <properties class="com.mirth.connect.connectors.tcp.TcpReceiverProperties" version="${V}">
      <pluginProperties/>
      <listenerConnectorProperties version="${V}">
        <host>0.0.0.0</host>
        <port>${port}</port>
      </listenerConnectorProperties>
      ${sourceProps({ responseVariable: 'Auto-generate (Before processing)', respondAfterProcessing: false })}
      <transmissionModeProperties class="com.mirth.connect.plugins.mllpmode.MLLPModeProperties">
        <pluginPointName>MLLP</pluginPointName>
        <startOfMessageBytes>0B</startOfMessageBytes>
        <endOfMessageBytes>1C0D</endOfMessageBytes>
        <useMLLPv2>false</useMLLPv2>
        <ackBytes>06</ackBytes>
        <nackBytes>15</nackBytes>
        <maxRetries>2</maxRetries>
      </transmissionModeProperties>
      <serverMode>true</serverMode>
      <remoteAddress></remoteAddress>
      <remotePort></remotePort>
      <overrideLocalBinding>false</overrideLocalBinding>
      <reconnectInterval>5000</reconnectInterval>
      <receiveTimeout>0</receiveTimeout>
      <bufferSize>65536</bufferSize>
      <maxConnections>20</maxConnections>
      <keepConnectionOpen>true</keepConnectionOpen>
      <dataTypeBinary>false</dataTypeBinary>
      <charsetEncoding>UTF-8</charsetEncoding>
      <respondOnNewConnection>0</respondOnNewConnection>
      <responseAddress></responseAddress>
      <responsePort></responsePort>
    </properties>
    ${transformer('transformer', dataType, dataType)}
    ${filter}
    <transportName>TCP Listener</transportName>
    <mode>SOURCE</mode>
    <enabled>true</enabled>
    <waitForPrevious>true</waitForPrevious>
  </sourceConnector>`
  };
}

/** Channel Reader with its own source queue (asynchronous hand-off between hub channels). */
export function channelReader(threads = 1): SourceConnector {
  return {
    xml: `<sourceConnector version="${V}">
    <metaDataId>0</metaDataId>
    <name>sourceConnector</name>
    <properties class="com.mirth.connect.connectors.vm.VmReceiverProperties" version="${V}">
      <pluginProperties/>
      ${sourceProps({ responseVariable: 'None', respondAfterProcessing: false, threads })}
    </properties>
    ${transformer('transformer', 'RAW', 'RAW')}
    ${filter}
    <transportName>Channel Reader</transportName>
    <mode>SOURCE</mode>
    <enabled>true</enabled>
    <waitForPrevious>true</waitForPrevious>
  </sourceConnector>`
  };
}

/** HTTP Listener that answers with the response of destination 1. */
export function httpListener(port: number, contextPath: string): SourceConnector {
  return {
    xml: `<sourceConnector version="${V}">
    <metaDataId>0</metaDataId>
    <name>sourceConnector</name>
    <properties class="com.mirth.connect.connectors.http.HttpReceiverProperties" version="${V}">
      <pluginProperties>
        <com.mirth.connect.plugins.httpauth.NoneHttpAuthProperties version="${V}">
          <authType>NONE</authType>
        </com.mirth.connect.plugins.httpauth.NoneHttpAuthProperties>
      </pluginProperties>
      <listenerConnectorProperties version="${V}">
        <host>0.0.0.0</host>
        <port>${port}</port>
      </listenerConnectorProperties>
      ${sourceProps({ responseVariable: 'd1', respondAfterProcessing: true })}
      <xmlBody>false</xmlBody>
      <parseMultipart>false</parseMultipart>
      <includeMetadata>false</includeMetadata>
      <binaryMimeTypes>application/.*(?&lt;!json|xml)$|image/.*|video/.*|audio/.*</binaryMimeTypes>
      <binaryMimeTypesRegex>true</binaryMimeTypesRegex>
      <responseContentType>application/json</responseContentType>
      <responseDataTypeBinary>false</responseDataTypeBinary>
      <responseStatusCode></responseStatusCode>
      <responseHeaders class="linked-hash-map"/>
      <responseHeadersVariable></responseHeadersVariable>
      <useResponseHeadersVariable>false</useResponseHeadersVariable>
      <charset>UTF-8</charset>
      <contextPath>${esc(contextPath)}</contextPath>
      <timeout>30000</timeout>
      <staticResources/>
    </properties>
    ${transformer('transformer', 'RAW', 'RAW')}
    ${filter}
    <transportName>HTTP Listener</transportName>
    <mode>SOURCE</mode>
    <enabled>true</enabled>
    <waitForPrevious>true</waitForPrevious>
  </sourceConnector>`
  };
}

// ---------------------------------------------------------------------------
// destination connectors

export interface QueueOptions {
  /** "on failure": try once, queue when the script returns QUEUED */
  enabled: boolean;
  retryIntervalMillis?: number;
  /** move a failing message to the back of the queue so others can proceed */
  rotate?: boolean;
  threads?: number;
  threadAssignmentVariable?: string;
}

export function javaScriptWriter(metaDataId: number, name: string, script: string, queue: QueueOptions = { enabled: false }): string {
  return `<connector version="${V}">
      <metaDataId>${metaDataId}</metaDataId>
      <name>${esc(name)}</name>
      <properties class="com.mirth.connect.connectors.js.JavaScriptDispatcherProperties" version="${V}">
        <pluginProperties/>
        <destinationConnectorProperties version="${V}">
          <queueEnabled>${queue.enabled}</queueEnabled>
          <sendFirst>${queue.enabled}</sendFirst>
          <retryIntervalMillis>${queue.retryIntervalMillis ?? 10000}</retryIntervalMillis>
          <regenerateTemplate>false</regenerateTemplate>
          <retryCount>0</retryCount>
          <rotate>${queue.rotate ?? false}</rotate>
          <includeFilterTransformer>false</includeFilterTransformer>
          <threadCount>${queue.threads ?? 1}</threadCount>
          <threadAssignmentVariable>${esc(queue.threadAssignmentVariable ?? '')}</threadAssignmentVariable>
          <validateResponse>false</validateResponse>
          ${resourceIds}
          <queueBufferSize>1000</queueBufferSize>
          <reattachAttachments>true</reattachAttachments>
        </destinationConnectorProperties>
        <script>${esc(script)}</script>
      </properties>
      ${transformer('transformer', 'RAW', 'RAW')}
      ${transformer('responseTransformer', 'RAW', 'RAW')}
      ${filter}
      <transportName>JavaScript Writer</transportName>
      <mode>DESTINATION</mode>
      <enabled>true</enabled>
      <waitForPrevious>true</waitForPrevious>
    </connector>`;
}

// ---------------------------------------------------------------------------
// channel

export interface ChannelDef {
  id: string;
  name: string;
  description: string;
  source: SourceConnector;
  destinations: string[];
  deployScript?: string;
  /** PRODUCTION keeps raw+processed content; DEVELOPMENT keeps everything */
  storageMode?: 'DEVELOPMENT' | 'PRODUCTION' | 'RAW' | 'METADATA' | 'DISABLED';
  tags?: string[];
  codeTemplateLibraryId: string;
}

export function channelXml(c: ChannelDef, revision = 1, lastModified = '1795000000000'): string {
  return `<channel version="${V}">
  <id>${c.id}</id>
  <nextMetaDataId>${c.destinations.length + 1}</nextMetaDataId>
  <name>${esc(c.name)}</name>
  <description>${esc(c.description)}</description>
  <revision>${revision}</revision>
  ${c.source.xml}
  <destinationConnectors>
    ${c.destinations.join('\n    ')}
  </destinationConnectors>
  <preprocessingScript>return message;</preprocessingScript>
  <postprocessingScript>return;</postprocessingScript>
  <deployScript>${esc(c.deployScript ?? 'return;')}</deployScript>
  <undeployScript>return;</undeployScript>
  <properties version="${V}">
    <clearGlobalChannelMap>true</clearGlobalChannelMap>
    <messageStorageMode>${c.storageMode ?? 'PRODUCTION'}</messageStorageMode>
    <encryptData>false</encryptData>
    <encryptAttachments>false</encryptAttachments>
    <encryptCustomMetaData>false</encryptCustomMetaData>
    <removeContentOnCompletion>false</removeContentOnCompletion>
    <removeOnlyFilteredOnCompletion>false</removeOnlyFilteredOnCompletion>
    <removeAttachmentsOnCompletion>false</removeAttachmentsOnCompletion>
    <initialState>STARTED</initialState>
    <storeAttachments>true</storeAttachments>
    <metaDataColumns>
      <metaDataColumn><name>SOURCE</name><type>STRING</type><mappingName>mirth_source</mappingName></metaDataColumn>
      <metaDataColumn><name>TYPE</name><type>STRING</type><mappingName>mirth_type</mappingName></metaDataColumn>
    </metaDataColumns>
    <attachmentProperties version="${V}">
      <type>None</type>
      <properties/>
    </attachmentProperties>
    ${resourceIds}
  </properties>
  <exportData>
    <metadata>
      <enabled>true</enabled>
      <lastModified>
        <time>${lastModified}</time>
        <timezone>UTC</timezone>
      </lastModified>
      <pruningSettings>
        <pruneMetaDataDays>30</pruneMetaDataDays>
        <pruneContentDays>7</pruneContentDays>
        <archiveEnabled>false</archiveEnabled>
        <pruneErroredMessages>false</pruneErroredMessages>
      </pruningSettings>
      <userId>1</userId>
    </metadata>
    <codeTemplateLibraries>
      <codeTemplateLibrary version="${V}">
        <id>${c.codeTemplateLibraryId}</id>
      </codeTemplateLibrary>
    </codeTemplateLibraries>
    <dependentIds/>
    <dependencyIds/>
    <channelTags>${(c.tags ?? []).map((t) => `<channelTag><id>${t}</id><name>${t}</name><channelIds><string>${c.id}</string></channelIds><backgroundColor><red>40</red><green>110</green><blue>180</blue><alpha>255</alpha></backgroundColor></channelTag>`).join('')}</channelTags>
  </exportData>
</channel>
`;
}

// ---------------------------------------------------------------------------
// code template library

export interface CodeTemplateDef {
  id: string;
  name: string;
  description: string;
  code: string;
}

const CONTEXTS = [
  'CHANNEL_DEPLOY',
  'CHANNEL_UNDEPLOY',
  'CHANNEL_PREPROCESSOR',
  'CHANNEL_POSTPROCESSOR',
  'SOURCE_RECEIVER',
  'SOURCE_FILTER_TRANSFORMER',
  'DESTINATION_FILTER_TRANSFORMER',
  'DESTINATION_DISPATCHER',
  'DESTINATION_RESPONSE_TRANSFORMER'
];

export function codeTemplateXml(t: CodeTemplateDef, revision = 1, lastModified = '1795000000000'): string {
  return `<codeTemplate version="${V}">
  <id>${t.id}</id>
  <name>${esc(t.name)}</name>
  <revision>${revision}</revision>
  <lastModified>
    <time>${lastModified}</time>
    <timezone>UTC</timezone>
  </lastModified>
  <contextSet>
    <delegate>
      ${CONTEXTS.map((c) => `<contextType>${c}</contextType>`).join('\n      ')}
    </delegate>
  </contextSet>
  <properties class="com.mirth.connect.model.codetemplates.BasicCodeTemplateProperties">
    <type>COMPILED_CODE</type>
    <code>${esc(t.code)}</code>
  </properties>
</codeTemplate>
`;
}

export function codeTemplateLibraryXml(
  lib: { id: string; name: string; description: string; channelIds: string[]; templates: CodeTemplateDef[] },
  revision = 1,
  lastModified = '1795000000000'
): string {
  return `<codeTemplateLibrary version="${V}">
  <id>${lib.id}</id>
  <name>${esc(lib.name)}</name>
  <revision>${revision}</revision>
  <lastModified>
    <time>${lastModified}</time>
    <timezone>UTC</timezone>
  </lastModified>
  <description>${esc(lib.description)}</description>
  <includeNewChannels>false</includeNewChannels>
  <enabledChannelIds>
    ${lib.channelIds.map((id) => `<string>${id}</string>`).join('\n    ')}
  </enabledChannelIds>
  <disabledChannelIds/>
  <codeTemplates>
    ${lib.templates.map((t) => `<codeTemplate version="${V}"><id>${t.id}</id></codeTemplate>`).join('\n    ')}
  </codeTemplates>
</codeTemplateLibrary>
`;
}
