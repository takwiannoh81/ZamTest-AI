; ZamTech AI Agent setup. Built by scripts/build-installer.mjs:
;   ISCC.exe /DAppVersion=0.3.9 /DStage=<staged app folder> /DOutDir=<output folder> zamtech-agent.iss
;
; Installs per user (no administrator rights) because desktop automation has to
; run in the user's signed-in session, not as a service. There is nothing to
; type: on Finish the tray app opens the Portal, where the person approves this
; PC (they are signed in there already), and then the Designer opens.
;
; Silent install for rolling out to many PCs, with an install key an Admin
; creates in the Portal (Bot Agents > Install keys), so no one has to approve:
;   ZamTechAI-Agent-Setup.exe /VERYSILENT /INSTALLKEY=<install key> [/NAME=finance-pc-01]
; Optional: /SERVER=https://api.example.com for another orchestrator,
; /MERGETASKS="browsers" downloads Chromium, /MERGETASKS="!autostart" skips
; starting at sign-in, /NOSTART leaves the agent stopped after setup.
; An upgrade waits for a running job to finish (up to 10 minutes) unless /CANCELJOB is given.

#ifndef AppVersion
  #define AppVersion "0.3.9"
#endif
#ifndef Stage
  #define Stage "..\dist\installer\app"
#endif
#ifndef OutDir
  #define OutDir "..\dist\installer"
#endif
#ifndef DefaultServer
  #define DefaultServer "https://api.zamtechai.com"
#endif
#ifndef DesignerUrl
  #define DesignerUrl "https://designer.zamtechai.com"
#endif

[Setup]
AppId={{6B3E2C4A-9F1D-4E7B-8C2A-5D0F3A1B7E94}
AppName=ZamTech AI Agent
AppVersion={#AppVersion}
AppVerName=ZamTech AI Agent {#AppVersion}
AppPublisher=ZamTech AI
AppPublisherURL=https://zamtechai.com
AppSupportURL=https://zamtechai.com
DefaultDirName={autopf}\ZamTech AI Agent
DefaultGroupName=ZamTech AI Agent
DisableProgramGroupPage=yes
DisableDirPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutDir}
OutputBaseFilename=ZamTechAI-Agent-Setup-{#AppVersion}
SetupIconFile={#Stage}\agent.ico
UninstallDisplayIcon={app}\ZamTechAgent.exe
UninstallDisplayName=ZamTech AI Agent
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
#ifdef WizardDir
; The ZamTech AI logo instead of Inno Setup's picture, drawn by IconGen.cs in every size.
WizardImageFile={#WizardDir}\wizard-large-*.bmp
WizardSmallImageFile={#WizardDir}\wizard-small-*.bmp
#endif
CloseApplications=no
RestartApplications=no
#ifdef Sign
; The "zamtech" sign tool is passed to ISCC by scripts/build-installer.mjs (/Szamtech=...).
SignTool=zamtech
SignedUninstaller=yes
#endif

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Messages]
FinishedHeadingLabel=ZamTech AI Agent is installed
FinishedLabel=When you click Finish, your browser opens the ZamTech AI Portal. Approve this PC there (sign in if asked), and the Designer opens next.

[Tasks]
Name: "autostart"; Description: "Start the agent when I sign in to Windows"
Name: "browsers"; Description: "Download Chromium for web automation (about 150 MB)"; Flags: unchecked

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\ZamTech AI Agent"; Filename: "{app}\ZamTechAgent.exe"
Name: "{group}\ZamTech AI Agent settings"; Filename: "{app}\ZamTechAgent.exe"; Parameters: "--settings"
Name: "{group}\ZamTech AI Designer"; Filename: "{#DesignerUrl}"; IconFilename: "{app}\ZamTechAgent.exe"
Name: "{group}\Desktop self-test"; Filename: "{cmd}"; Parameters: "/s /c ""title Desktop self-test & ""{app}\node.exe"" ""{app}\agent.mjs"" desktop-test & echo. & pause"""; WorkingDir: "{app}\logs"; IconFilename: "{app}\ZamTechAgent.exe"
Name: "{group}\Agent logs"; Filename: "{app}\logs"

[Dirs]
Name: "{app}\logs"

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "ZamTech AI Agent"; ValueData: """{app}\ZamTechAgent.exe"""; Tasks: autostart; Flags: uninsdeletevalue
; Unchecking the task on an upgrade removes the old entry.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "ZamTech AI Agent"; Tasks: not autostart; Flags: deletevalue

[Run]
Filename: "{app}\node.exe"; Parameters: """{app}\node_modules\playwright\cli.js"" install chromium"; StatusMsg: "Downloading Chromium for web automation..."; Tasks: browsers; Flags: runhidden waituntilterminated
; --first-run: approve this PC in the Portal, which then opens the Designer.
Filename: "{app}\ZamTechAgent.exe"; Parameters: "--first-run"; Description: "Connect this PC and open the ZamTech AI Designer"; Flags: postinstall nowait skipifsilent
Filename: "{app}\ZamTechAgent.exe"; Flags: nowait; Check: WizardSilent and not CmdLineParamExists('/NOSTART')

[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"
Type: files; Name: "{app}\agent.json"
Type: files; Name: "{app}\setup.json"
Type: files; Name: "{app}\status.txt"

[Code]
var
  DesignerIntro: TNewStaticText;
  DesignerEdit: TNewEdit;
  CopyButton: TNewButton;

function CmdLineParamExists(const Value: String): Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), Value) = 0 then
    begin
      Result := True;
      Exit;
    end;
end;

function Param(const Name: String): String;
begin
  Result := Trim(ExpandConstant('{param:' + Name + '|}'));
end;

function JsonString(const S: String): String;
var
  I: Integer;
  C: Char;
begin
  Result := '"';
  for I := 1 to Length(S) do
  begin
    C := S[I];
    if C = '"' then Result := Result + '\"'
    else if C = '\' then Result := Result + '\\'
    else if Ord(C) < 32 then Result := Result + ' '
    else Result := Result + C;
  end;
  Result := Result + '"';
end;

procedure AddJson(var Json: String; const Name, Value: String);
begin
  if Value = '' then Exit;
  if Json <> '' then Json := Json + ',';
  Json := Json + JsonString(Name) + ':' + JsonString(Value);
end;

// --- Finish page: the Designer address ---

procedure CopyDesignerUrl(Sender: TObject);
var
  Code: Integer;
begin
  Exec(ExpandConstant('{cmd}'), '/c echo|set /p="{#DesignerUrl}"|clip', '', SW_HIDE, ewWaitUntilTerminated, Code);
  CopyButton.Caption := 'Copied';
end;

procedure InitializeWizard;
begin
  DesignerIntro := TNewStaticText.Create(WizardForm);
  DesignerIntro.Parent := WizardForm.FinishedPage;
  DesignerIntro.Caption := 'Your automations are built in the ZamTech AI Designer:';
  DesignerIntro.AutoSize := True;

  DesignerEdit := TNewEdit.Create(WizardForm);
  DesignerEdit.Parent := WizardForm.FinishedPage;
  DesignerEdit.Text := '{#DesignerUrl}';
  DesignerEdit.ReadOnly := True;

  CopyButton := TNewButton.Create(WizardForm);
  CopyButton.Parent := WizardForm.FinishedPage;
  CopyButton.Caption := 'Copy';
  CopyButton.OnClick := @CopyDesignerUrl;
end;

procedure CurPageChanged(CurPageID: Integer);
var
  Top: Integer;
begin
  if CurPageID <> wpFinished then Exit;
  // Below the "Connect this PC and open the Designer" check box.
  Top := WizardForm.RunList.Top + WizardForm.RunList.Height + ScaleY(20);
  DesignerIntro.Left := WizardForm.FinishedLabel.Left;
  DesignerIntro.Top := Top;
  DesignerEdit.Left := WizardForm.FinishedLabel.Left;
  DesignerEdit.Top := DesignerIntro.Top + DesignerIntro.Height + ScaleY(6);
  CopyButton.Width := ScaleX(75);
  CopyButton.Height := WizardForm.NextButton.Height;
  CopyButton.Left := WizardForm.FinishedLabel.Left + WizardForm.FinishedLabel.Width - CopyButton.Width;
  DesignerEdit.Width := CopyButton.Left - DesignerEdit.Left - ScaleX(8);
  CopyButton.Top := DesignerEdit.Top + (DesignerEdit.Height - CopyButton.Height) div 2;
end;

// --- stopping a running agent ---

function AgentExe: String;
begin
  Result := ExpandConstant('{app}\ZamTechAgent.exe');
end;

// The tray app keeps status.txt at "busy" while a job runs.
function JobRunning: Boolean;
var
  Status: AnsiString;
begin
  Result := LoadStringFromFile(ExpandConstant('{app}\status.txt'), Status) and (Pos('busy', Status) = 1);
end;

// Stops a running agent, letting its job finish unless the user chooses to cancel it.
// Returns an error message, or '' once the agent has stopped.
function StopAgent(const Silent: Boolean; const Action: String): String;
var
  Code: Integer;
  Args: String;
begin
  Result := '';
  if not FileExists(AgentExe) then Exit;
  Args := '--quit --wait 700';
  if CmdLineParamExists('/CANCELJOB') then
    Args := '--quit --now --wait 60'
  else if (not Silent) and JobRunning then
    case MsgBox('A job is running on this PC.' + #13#10#13#10 +
        'Yes: let it finish, then ' + Action + ' (waits up to 10 minutes).' + #13#10 +
        'No: cancel the job and ' + Action + ' now.', mbConfirmation, MB_YESNOCANCEL) of
      IDNO: Args := '--quit --now --wait 60';
      IDCANCEL: begin
        Result := 'Cancelled so the running job can finish.';
        Exit;
      end;
    end;
  Exec(AgentExe, Args, '', SW_HIDE, ewWaitUntilTerminated, Code);
  if Code = 2 then
    Result := 'The agent is still running a job. Try again when it has finished, or quit the agent from its tray icon.';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := StopAgent(WizardSilent, 'update');
end;

function InitializeUninstall: Boolean;
var
  Error: String;
begin
  Error := StopAgent(UninstallSilent, 'uninstall');
  Result := Error = '';
  if not Result and not UninstallSilent then MsgBox(Error, mbError, MB_OK);
end;

// --- choices for the tray app: setup.json ---

// The tray app merges setup.json into agent.json when it starts, so an upgrade
// keeps this PC's credential. A fresh install gets the default server.
procedure WriteSetupChoices;
var
  Json, Server: String;
  Lines: TArrayOfString;
begin
  Server := Param('SERVER');
  while (Length(Server) > 0) and (Server[Length(Server)] = '/') do
    Delete(Server, Length(Server), 1);
  if (Server = '') and not FileExists(ExpandConstant('{app}\agent.json')) then Server := '{#DefaultServer}';
  Json := '';
  AddJson(Json, 'server', Server);
  AddJson(Json, 'name', Param('NAME'));
  AddJson(Json, 'installKey', Param('INSTALLKEY'));
  if Json = '' then Exit;
  ForceDirectories(ExpandConstant('{app}'));
  SetArrayLength(Lines, 1);
  Lines[0] := '{' + Json + '}';
  SaveStringsToUTF8File(ExpandConstant('{app}\setup.json'), Lines, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  // Before the files are copied, so it is in place before any tray app starts.
  if CurStep = ssInstall then WriteSetupChoices;
end;
