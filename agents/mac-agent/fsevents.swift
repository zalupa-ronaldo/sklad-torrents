import CoreServices
import Foundation

// FSEvents history for one tree. The agent persists the numeric id and passes it back
// after a restart so the stream resumes. A dropped history is reported as lost; the
// agent then takes one walk. This file is original and does not copy Apple sample code.
let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/Volumes"
let since: FSEventStreamEventId
if CommandLine.arguments.count > 2, let value = UInt64(CommandLine.arguments[2]), value > 0 {
  since = value
} else {
  since = FSEventStreamEventId(kFSEventStreamEventIdSinceNow)
}

let callback: FSEventStreamCallback = { _, _, numEvents, eventPaths, eventFlags, eventIds in
  guard let paths = unsafeBitCast(eventPaths, to: NSArray.self) as? [String] else { return }
  for index in 0..<numEvents {
    let flag = eventFlags[index]
    let lost = (flag & UInt32(kFSEventStreamEventFlagHistoryDropped | kFSEventStreamEventFlagKernelDropped | kFSEventStreamEventFlagMustScanSubDirs)) != 0
    let payload: [String: Any] = ["path": paths[index], "id": eventIds[index], "lost": lost]
    if let data = try? JSONSerialization.data(withJSONObject: payload), let line = String(data: data, encoding: .utf8) {
      print(line)
      fflush(stdout)
    }
  }
}

var context = FSEventStreamContext(version: 0, info: nil, retain: nil, release: nil, copyDescription: nil)
let paths = [root] as CFArray
let flags = FSEventStreamCreateFlags(kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagUseCFTypes)
guard let stream = FSEventStreamCreate(nil, callback, &context, paths, since, 0.5, flags) else {
  fputs("{\"lost\":true}\n", stderr)
  exit(1)
}
FSEventStreamScheduleWithRunLoop(stream, CFRunLoopGetCurrent(), CFRunLoopMode.defaultMode.rawValue)
if !FSEventStreamStart(stream) {
  fputs("{\"lost\":true}\n", stderr)
  exit(1)
}
let latest = FSEventStreamGetLatestEventId(stream)
print("{\"cursor\":\(latest)}")
fflush(stdout)
CFRunLoopRun()
