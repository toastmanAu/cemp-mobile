/* See CempQrScannerViewController.h for the behaviour contract. */

#import "CempQrScannerViewController.h"

#import <AVFoundation/AVFoundation.h>

@interface CempQrScannerViewController () <AVCaptureMetadataOutputObjectsDelegate>
@end

@implementation CempQrScannerViewController {
  AVCaptureSession *_session;
  AVCaptureVideoPreviewLayer *_preview;
  BOOL _finished;
  // Guards the authorization-check/session-setup path against re-running:
  // viewDidAppear: can fire again (e.g. backgrounding then foregrounding
  // while the sheet is still up) without a new presentation.
  BOOL _started;
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
    case AVAuthorizationStatusAuthorized:
      [self setUpAndStartSession];
      break;
    case AVAuthorizationStatusNotDetermined:
      // Triggers the system permission prompt (gated by
      // NSCameraUsageDescription in Info.plist).
      [AVCaptureDevice requestAccessForMediaType:AVMediaTypeVideo
                               completionHandler:^(BOOL granted) {
        dispatch_async(dispatch_get_main_queue(), ^{
          if (granted) {
            [self setUpAndStartSession];
          } else {
            [self finishWith:nil]; // denial is a cancel
          }
        });
      }];
      break;
    case AVAuthorizationStatusDenied:
    case AVAuthorizationStatusRestricted:
      [self finishWith:nil];
      break;
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

  // startRunning blocks; keep it off the main queue.
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    [self->_session startRunning];
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
  if (_finished) {
    return;
  }
  _finished = YES;
  [_session stopRunning];
  void (^handler)(NSString *_Nullable) = self.onResult;
  self.onResult = nil;
  if (handler != nil) {
    handler(text);
  }
}

@end
