/* See CempQrScannerViewController.h for the behaviour contract. */

#import "CempQrScannerViewController.h"

#import <AVFoundation/AVFoundation.h>
#import <stdatomic.h>

@interface CempQrScannerViewController () <AVCaptureMetadataOutputObjectsDelegate>
@end

@implementation CempQrScannerViewController {
  AVCaptureSession *_session;
  AVCaptureVideoPreviewLayer *_preview;
  // Dedicated serial queue for all AVCaptureSession start/stop, per
  // Apple's documented guidance for capture session lifecycle work.
  // Serial, not the global concurrent queue: with a concurrent queue,
  // a startRunning submitted first and a stopRunning submitted after it
  // (from finishWith:) have no ordering guarantee relative to each other
  // — a worker thread could run stopRunning to completion before the
  // start block even reaches its atomic_load check, and startRunning
  // could then complete afterwards, leaving a live session with no
  // settle site left to stop it. A private serial queue makes "submitted
  // after" mean "runs after": stopRunning enqueued once a start has
  // already been submitted is guaranteed to run after it, so either the
  // start block observes _finished and tears itself down, or it starts
  // and the already-queued stop reliably stops it right after. This is
  // what actually closes the class of bug the atomic _finished check
  // could only narrow.
  dispatch_queue_t _sessionQueue;
  // atomic, not a plain BOOL: finishWith:'s check-and-set is the guard
  // that decides whether a racing session-queue startRunning is allowed
  // to fire (see setUpAndStartSession). dispatch_async only orders
  // writes made BEFORE the dispatch call against the block it queues —
  // _finished is written AFTER that dispatch, on the main thread, so the
  // session-queue block's read of it has no synchronisation with that
  // write under the plain-BOOL C memory model. That gap is exactly the
  // leaked-camera bug this file exists to prevent, so the flag itself
  // has to be race-free, not just "usually fine on ARM64".
  atomic_bool _finished;
  // Guards the authorization-check/session-setup path against re-running:
  // viewDidAppear: can fire again (e.g. backgrounding then foregrounding
  // while the sheet is still up) without a new presentation. Only ever
  // read/written on the main thread, so a plain BOOL is fine here.
  BOOL _started;
}

- (instancetype)init
{
  self = [super init];
  if (self) {
    _sessionQueue = dispatch_queue_create("com.cempmobile.qrscanner.session",
                                          DISPATCH_QUEUE_SERIAL);
  }
  return self;
}

- (void)viewDidLoad
{
  [super viewDidLoad];
  // View construction only. Anything that can fail immediately (no camera,
  // denied permission) must NOT settle from here: viewDidLoad runs while
  // this controller's presentViewController: transition is still in
  // flight, and dismissing mid-transition is a UIKit race — the dismiss
  // can be dropped, leaving the controller stuck on screen with the
  // promise unsettled. Those checks live in viewDidAppear: instead, which
  // fires only once the presentation has completed.
  self.view.backgroundColor = UIColor.blackColor;

  UIButton *cancel = [UIButton buttonWithType:UIButtonTypeSystem];
  [cancel setTitle:@"Cancel" forState:UIControlStateNormal];
  [cancel setTitleColor:UIColor.whiteColor forState:UIControlStateNormal];
  [cancel addTarget:self action:@selector(cancelTapped) forControlEvents:UIControlEventTouchUpInside];
  cancel.translatesAutoresizingMaskIntoConstraints = NO;
  [self.view addSubview:cancel];
  [NSLayoutConstraint activateConstraints:@[
    [cancel.centerXAnchor constraintEqualToAnchor:self.view.centerXAnchor],
    [cancel.bottomAnchor constraintEqualToAnchor:self.view.safeAreaLayoutGuide.bottomAnchor
                                        constant:-24],
  ]];
}

- (void)viewDidAppear:(BOOL)animated
{
  [super viewDidAppear:animated];
  if (_started) {
    return;
  }
  _started = YES;
  [self beginAuthorizationCheck];
}

/**
 * Checks camera authorization before touching AVCaptureSession at all.
 * AVCaptureDeviceInput/canAddInput: do NOT fail for a denied camera — the
 * input constructs fine and the session simply delivers no frames, which
 * would otherwise leave the user stuck on a black preview with no way out
 * but hunting for Cancel. Checking authorizationStatusForMediaType: first
 * makes denial (and restriction) resolve promptly, matching the Android
 * side's "denied permission is a cancel" contract.
 */
- (void)beginAuthorizationCheck
{
  switch ([AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]) {
    case AVAuthorizationStatusAuthorized: {
      [self setUpAndStartSession];
      break;
    }
    case AVAuthorizationStatusNotDetermined: {
      // Triggers the system permission prompt (gated by
      // NSCameraUsageDescription in Info.plist).
      [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo
                               completionHandler:^(BOOL granted) {
        dispatch_async(dispatch_get_main_queue(), ^{
          if (atomic_load(&self->_finished)) {
            // Cancelled while the system prompt was up (or in the hop
            // back to main) — do not start a session for a promise that
            // already settled.
            return;
          }
          if (granted) {
            [self setUpAndStartSession];
          } else {
            [self finishWith:nil]; // denial is a cancel
          }
        });
      }];
      break;
    }
    case AVAuthorizationStatusDenied:
    case AVAuthorizationStatusRestricted: {
      [self finishWith:nil];
      break;
    }
  }
}

- (void)setUpAndStartSession
{
  _session = [[AVCaptureSession alloc] init];
  AVCaptureDevice *device = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
  NSError *error = nil;
  AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&error];
  if (input == nil || ![_session canAddInput:input]) {
    // No usable camera (simulator, hardware fault) is a cancel, not a crash.
    // Safe to settle here: this only runs from viewDidAppear:'s callers,
    // after the presentation transition has already completed.
    [self finishWith:nil];
    return;
  }
  [_session addInput:input];

  AVCaptureMetadataOutput *output = [[AVCaptureMetadataOutput alloc] init];
  [_session addOutput:output];
  [output setMetadataObjectsDelegate:self queue:dispatch_get_main_queue()];
  output.metadataObjectTypes = @[ AVMetadataObjectTypeQRCode ];

  _preview = [AVCaptureVideoPreviewLayer layerWithSession:_session];
  _preview.videoGravity = AVLayerVideoGravityResizeAspectFill;
  _preview.frame = self.view.layer.bounds;
  [self.view.layer addSublayer:_preview];

  // startRunning blocks; keep it off the main queue, and use the private
  // serial _sessionQueue (not the global concurrent queue) so a
  // stopRunning submitted afterwards from finishWith: is guaranteed to
  // run after this block, not concurrently with or before it. Cancel can
  // land on the main thread while this dispatch is still in flight —
  // finishWith: would already have called stopRunning on a session that
  // hadn't started yet (a no-op at that instant), so re-check _finished
  // on the far side of the queue hop as a fast path; the serial ordering
  // is what guarantees the queued stopRunning still wins even if this
  // block doesn't observe _finished yet. This read genuinely races the
  // main-thread write in finishWith: (dispatch_async only orders what
  // happened before the dispatch, not writes made after it), hence
  // atomic_load rather than a plain ivar read.
  AVCaptureSession *session = _session;
  dispatch_async(_sessionQueue, ^{
    if (atomic_load(&self->_finished)) {
      [session stopRunning]; // tear down rather than leak a live camera.
      return;
    }
    [session startRunning];
  });
}

- (void)viewDidLayoutSubviews
{
  [super viewDidLayoutSubviews];
  _preview.frame = self.view.layer.bounds;
}

- (void)cancelTapped
{
  [self finishWith:nil];
}

- (void)captureOutput:(AVCaptureOutput *)output
    didOutputMetadataObjects:(NSArray<__kindof AVMetadataObject *> *)objects
              fromConnection:(AVCaptureConnection *)connection
{
  for (AVMetadataObject *object in objects) {
    if (![object isKindOfClass:[AVMetadataMachineReadableCodeObject class]]) {
      continue;
    }
    NSString *value = ((AVMetadataMachineReadableCodeObject *)object).stringValue;
    if (value.length > 0) {
      [self finishWith:value];
      return;
    }
  }
}

/** Fires onResult exactly once, whatever path got here. */
- (void)finishWith:(NSString *_Nullable)text
{
  // atomic_exchange is the check-and-set: it sets _finished to true and
  // returns whatever was there before, in one indivisible operation. That
  // is what makes this race-free now — not thread confinement (this is
  // still always called from the main thread, but setUpAndStartSession's
  // dispatched startRunning block reads _finished from a background
  // queue with no ordering guarantee against this write, so the flag
  // itself has to be safe to read cross-thread, not just written from a
  // single thread).
  if (atomic_exchange(&_finished, true)) {
    return; // already settled.
  }
  AVCaptureSession *session = _session;
  if (session != nil) {
    // stopRunning blocks configuring/tearing down capture hardware,
    // symmetric with startRunning — keep it off the main thread so
    // Cancel or a successful decode doesn't stutter the dismissal. Same
    // private serial _sessionQueue as setUpAndStartSession's
    // startRunning: because the queue is serial, this stopRunning is
    // guaranteed to run after any startRunning already submitted for
    // this session, closing the race the atomic _finished check could
    // only narrow (a concurrent queue gives no such ordering between
    // two independently-submitted blocks).
    dispatch_async(_sessionQueue, ^{
      [session stopRunning];
    });
  }
  void (^handler)(NSString *_Nullable) = self.onResult;
  self.onResult = nil;
  if (handler != nil) {
    handler(text);
  }
}

@end
