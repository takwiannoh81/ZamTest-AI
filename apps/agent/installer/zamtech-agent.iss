; ZamTech AI Agent setup. Built by scripts/build-installer.mjs:
;   ISCC.exe /DAppVersion=0.1.0 /DStage=<staged app folder> /DOutDir=<output folder> zamtech-agent.iss
;
; Installs per user (no administrator rights) because desktop automation has to
; run in the user's signed-in session, not as a service.
;
; Silent install for rolling out to many PCs:
;   ZamTechAI-Agent-Setup-<version>.exe /VERYSILENT /SERVER=https://api.zamtechai.com /KEY=<agent key> [/NAME=finance-pc-01]
; Optional: /MERGETASKS="browsers" downloads Chromium, /MERGETASKS="!autostart" skips
; starting at sign-in, /NOSTART leaves the agent stopped after setup.
; An upgrade waits for a running job to finish (up to 10 minutes) unless /CANCELJOB is given.

#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif
#ifndef Stage
  #define Stage "..\dist\installer\app"
#endif
#ifndef OutDir
  #define OutDir "..\dist\installer"
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
CloseApplications=no
RestartApplications=no
#ifdef Sign
; The "zamtech" sign tool is passed to ISCC by scripts/build-installer.mjs (/Szamtech=...).
SignTool=zamtech
SignedUninstaller=yes
#endif

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "autostart"; Description: "Start the agent when I sign in to Windows"
Name: "browsers"; Description: "Download Chromium for web automation (about 150 MB)"; Flags: unchecked

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\ZamTech AI Agent"; Filename: "{app}\ZamTechAgent.exe"
Name: "{group}\ZamTech AI Agent settings"; Filename: "{app}\ZamTechAgent.exe"; Parameters: "--settings"
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
Filename: "{app}\ZamTechAgent.exe"; Description: "Start ZamTech AI Agent now"; Flags: postinstall nowait skipifsilent
Filename: "{app}\ZamTechAgent.exe"; Flags: nowait; Check: WizardSilent and not CmdLineParamExists('/NOSTART')

[UninstallDelete]
Type: filesandordirs; Name: "{app}\logs"
Type: files; Name: "{app}\agent.json"
Type: files; Name: "{app}\status.txt"

[Code]
var
  ConnectPage: TInputQueryWizardPage;

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

function ParamOr(const Name, Default: String): String;
begin
  Result := ExpandConstant('{param:' + Name + '|' + Default + '}');
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

function ConfigPath: String;
begin
  Result := ExpandConstant('{app}\agent.json');
end;

procedure InitializeWizard;
begin
  ConnectPage := CreateInputQueryPage(wpSelectTasks,
    'Connect to your orchestrator',
    'Where should this bot agent get its jobs from?',
    'Ask your administrator for the agent key (ZAMTEST_AGENT_KEY in deploy/.env on the server). ' +
    'Leave the key empty on an upgrade to keep the current settings.');
  ConnectPage.Add('Server URL:', False);
  ConnectPage.Add('Agent key:', True);
  ConnectPage.Add('Bot name (how this PC appears in the Portal):', False);
  ConnectPage.Values[0] := ParamOr('SERVER', GetPreviousData('Server', 'https://api.zamtechai.com'));
  ConnectPage.Values[1] := ParamOr('KEY', '');
  ConnectPage.Values[2] := ParamOr('NAME', GetPreviousData('BotName', GetComputerNameString));
end;

procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  SetPreviousData(PreviousDataKey, 'Server', ConnectPage.Values[0]);
  SetPreviousData(PreviousDataKey, 'BotName', ConnectPage.Values[2]);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Server: String;
begin
  Result := True;
  if CurPageID = ConnectPage.ID then
  begin
    Server := Trim(ConnectPage.Values[0]);
    if (Pos('https://', Lowercase(Server)) <> 1) and (Pos('http://', Lowercase(Server)) <> 1) then
    begin
      MsgBox('Enter the server address, for example https://api.zamtechai.com', mbError, MB_OK);
      Result := False;
    end
    else if (Trim(ConnectPage.Values[1]) = '') and not FileExists(ConfigPath) then
    begin
      Result := MsgBox('No agent key entered. The agent will not connect until you add it in its Settings. Continue?',
        mbConfirmation, MB_YESNO) = IDYES;
    end;
  end;
end;

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

procedure WriteConfig;
var
  Server, Key, Name: String;
  Lines: TArrayOfString;
  Code: Integer;
begin
  Server := Trim(ConnectPage.Values[0]);
  while (Length(Server) > 0) and (Server[Length(Server)] = '/') do
    Delete(Server, Length(Server), 1);
  Key := Trim(ConnectPage.Values[1]);
  Name := Trim(ConnectPage.Values[2]);
  // An upgrade without a new key keeps agent.json as it is.
  if (Key = '') and FileExists(ConfigPath) then Exit;
  SetArrayLength(Lines, 1);
  Lines[0] := '{"server":' + JsonString(Server) + ',"key":' + JsonString(Key) + ',"name":' + JsonString(Name) + '}';
  SaveStringsToUTF8File(ConfigPath, Lines, False);
  // Encrypt the key for this Windows user straight away.
  Exec(ExpandConstant('{app}\ZamTechAgent.exe'), '--protect-key', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then WriteConfig;
end;

