import DiskArbitration
import Foundation

// Original. Apple DiskArbitration public API, one line per appear or disappear.
// This process blocks on the dispatch queue. It does not poll and it does not
// copy objc2-disk-arbitration or Apple sample code.

func emit(type: String, disk: DADisk) {
  let raw = DADiskCopyDescription(disk) as? [NSString: Any]
  var mount = ""
  if let url = raw?[kDADiskDescriptionVolumePathKey] as? URL {
    mount = url.path
  }
  let name = (raw?[kDADiskDescriptionVolumeNameKey] as? String) ?? ""
  let payload: [String: Any] = ["type": type, "mount": mount, "name": name]
  if let data = try? JSONSerialization.data(withJSONObject: payload),
     let line = String(data: data, encoding: .utf8) {
    print(line)
    fflush(stdout)
  }
}

guard let session = DASessionCreate(nil) else {
  fputs("{\"lost\":true}\n", stderr)
  exit(1)
}

let appear: DADiskAppearedCallback = { _, disk, _ in
  emit(type: "attach", disk: disk)
}
let gone: DADiskDisappearedCallback = { _, disk, _ in
  emit(type: "detach", disk: disk)
}

DASessionSetDispatchQueue(session, DispatchQueue.global())
DARegisterDiskAppearedCallback(session, nil, appear, nil)
DARegisterDiskDisappearedCallback(session, nil, gone, nil)
dispatchMain()
