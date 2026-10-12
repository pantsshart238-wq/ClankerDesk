# ===========================================================================
# ClankerDesk host window -- the agent's own built-in UI.
# agent.js launches this (it needs no extra installs: WPF ships with Windows).
# The window reads http://127.0.0.1:<port>/host-status every 2 seconds, so it
# always shows the live truth: online/offline, the device PIN, and the links.
# ===========================================================================

param(
  [int]$Port = 8000
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName PresentationFramework

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="ClankerDesk" Width="430" Height="610"
        ResizeMode="CanMinimize" WindowStartupLocation="CenterScreen"
        Background="#F4F6FA" FontFamily="Segoe UI">
  <Window.Resources>
    <Style x:Key="Card" TargetType="Border">
      <Setter Property="Background" Value="White"/>
      <Setter Property="BorderBrush" Value="#E4E7EB"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="CornerRadius" Value="14"/>
      <Setter Property="Padding" Value="16"/>
    </Style>
    <Style x:Key="CardTitle" TargetType="TextBlock">
      <Setter Property="FontSize" Value="10"/>
      <Setter Property="FontWeight" Value="Bold"/>
      <Setter Property="Foreground" Value="#8A94A0"/>
    </Style>
    <Style x:Key="BtnPrimary" TargetType="Button">
      <Setter Property="Background" Value="#2F6FE4"/>
      <Setter Property="Foreground" Value="White"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Padding" Value="16,8"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" Background="{TemplateBinding Background}" CornerRadius="9" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="b" Property="Background" Value="#245FCE"/>
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="b" Property="Background" Value="#1D4FAF"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="BtnGhost" TargetType="Button">
      <Setter Property="Background" Value="White"/>
      <Setter Property="Foreground" Value="#101418"/>
      <Setter Property="BorderBrush" Value="#E4E7EB"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Padding" Value="14,8"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
                    BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="9" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="b" Property="Background" Value="#F2F5F9"/>
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="b" Property="Background" Value="#E8EDF4"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="BtnDanger" TargetType="Button">
      <Setter Property="Background" Value="White"/>
      <Setter Property="Foreground" Value="#D9232A"/>
      <Setter Property="BorderBrush" Value="#F2B8BC"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="FontSize" Value="12"/>
      <Setter Property="Padding" Value="14,8"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="b" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
                    BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="9" Padding="{TemplateBinding Padding}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter Property="Background" Value="#D9232A"/>
                <Setter Property="BorderBrush" Value="#D9232A"/>
                <Setter Property="Foreground" Value="White"/>
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter Property="Background" Value="#B01B21"/>
                <Setter Property="BorderBrush" Value="#B01B21"/>
                <Setter Property="Foreground" Value="White"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
  </Window.Resources>

  <ScrollViewer VerticalScrollBarVisibility="Auto" Background="Transparent">
    <StackPanel Margin="22,20,22,18">

      <TextBlock Text="ClankerDesk" FontSize="24" FontWeight="Bold" Foreground="#101418"/>
      <TextBlock Text="Host control panel — live while the agent runs" FontSize="11.5" Foreground="#5C6670" Margin="0,2,0,0"/>

      <Border Margin="0,12,0,0" HorizontalAlignment="Left" CornerRadius="12"
              Background="White" BorderBrush="#E4E7EB" BorderThickness="1">
        <StackPanel Orientation="Horizontal" Margin="12,6">
          <Ellipse x:Name="StatusDot" Width="9" Height="9" Fill="#9AA4B0" VerticalAlignment="Center" Margin="0,0,8,0"/>
          <TextBlock x:Name="StatusText" Text="starting&#8230;" FontWeight="SemiBold" FontSize="12" Foreground="#374151"/>
        </StackPanel>
      </Border>

      <!-- your device -->
      <Border Style="{StaticResource Card}" Margin="0,14,0,0">
        <StackPanel>
          <TextBlock Text="YOUR DEVICE" Style="{StaticResource CardTitle}"/>
          <TextBlock x:Name="NameText" Text="&#8230;" FontSize="12" FontWeight="SemiBold" Foreground="#101418" Margin="0,6,0,0"/>
          <TextBlock x:Name="PinText" Text="······" FontFamily="Consolas" FontSize="26" FontWeight="Bold" Foreground="#2F6FE4" Margin="0,8,0,0"/>
          <TextBlock Text="Give this PIN to the people you let onto this PC." FontSize="10.5" Foreground="#5C6670" Margin="0,6,0,0" TextWrapping="Wrap"/>
          <Button x:Name="CopyPinBtn" Content="Copy PIN" Style="{StaticResource BtnPrimary}" HorizontalAlignment="Left" Margin="0,10,0,0"/>
        </StackPanel>
      </Border>

      <!-- links -->
      <Border Style="{StaticResource Card}" Margin="0,12,0,0">
        <StackPanel>
          <TextBlock Text="LINKS" Style="{StaticResource CardTitle}"/>
          <TextBlock Text="Permanent link (share this)" FontSize="10.5" FontWeight="Bold" Foreground="#8A94A0" Margin="0,8,0,0"/>
          <TextBlock x:Name="RelayText" Text="&#8230;" FontFamily="Consolas" FontSize="11" Foreground="#2F6FE4" TextWrapping="Wrap" Margin="0,3,0,0"/>
          <Button x:Name="CopyRelayBtn" Content="Copy link" Style="{StaticResource BtnGhost}" HorizontalAlignment="Left" Margin="0,8,0,0"/>
          <Border x:Name="TunnelPanel" Visibility="Collapsed" Margin="0,12,0,0" BorderBrush="#EEF1F5" BorderThickness="1,0,0,0" Padding="0,10,0,0">
            <StackPanel>
              <TextBlock Text="Temporary tunnel link (changes every restart)" FontSize="10.5" FontWeight="Bold" Foreground="#8A94A0"/>
              <TextBlock x:Name="TunnelText" Text="" FontFamily="Consolas" FontSize="11" Foreground="#5C6670" TextWrapping="Wrap" Margin="0,3,0,0"/>
              <Button x:Name="CopyTunnelBtn" Content="Copy tunnel link" Style="{StaticResource BtnGhost}" HorizontalAlignment="Left" Margin="0,8,0,0"/>
            </StackPanel>
          </Border>
        </StackPanel>
      </Border>

      <!-- right now -->
      <Border Style="{StaticResource Card}" Margin="0,12,0,0">
        <StackPanel>
          <TextBlock Text="RIGHT NOW" Style="{StaticResource CardTitle}"/>
          <UniformGrid Columns="4" Margin="0,8,0,0">
            <StackPanel><TextBlock x:Name="StatRelay" Text="&#8212;" FontSize="15" FontWeight="Bold" Foreground="#101418"/><TextBlock Text="RELAY" FontSize="8.5" FontWeight="Bold" Foreground="#8A94A0"/></StackPanel>
            <StackPanel><TextBlock x:Name="StatTunnel" Text="&#8212;" FontSize="15" FontWeight="Bold" Foreground="#101418"/><TextBlock Text="TUNNEL" FontSize="8.5" FontWeight="Bold" Foreground="#8A94A0"/></StackPanel>
            <StackPanel><TextBlock x:Name="StatCapture" Text="&#8212;" FontSize="15" FontWeight="Bold" Foreground="#101418"/><TextBlock Text="STREAMING" FontSize="8.5" FontWeight="Bold" Foreground="#8A94A0"/></StackPanel>
            <StackPanel><TextBlock x:Name="StatUptime" Text="&#8212;" FontSize="15" FontWeight="Bold" Foreground="#101418"/><TextBlock Text="UPTIME" FontSize="8.5" FontWeight="Bold" Foreground="#8A94A0"/></StackPanel>
          </UniformGrid>
          <StackPanel Orientation="Horizontal" Margin="0,12,0,0">
            <Button x:Name="OpenDashBtn" Content="Open dashboard" Style="{StaticResource BtnPrimary}"/>
            <Button x:Name="WatchBtn" Content="Watch this PC" Style="{StaticResource BtnGhost}" Margin="10,0,0,0"/>
          </StackPanel>
          <StackPanel Orientation="Horizontal" Margin="0,8,0,0">
            <Button x:Name="StopBtn" Content="Stop agent" Style="{StaticResource BtnDanger}"/>
          </StackPanel>
        </StackPanel>
      </Border>

      <TextBlock Text="Settings live in config.json (edit with Notepad, then restart the agent).&#10;Closing this window does NOT stop the agent -- press Stop agent to shut it down." FontSize="10" Foreground="#8A94A0" Margin="0,14,0,0" TextWrapping="Wrap"/>

    </StackPanel>
  </ScrollViewer>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$window = [Windows.Markup.XamlReader]::Load($reader)

$StatusDot    = $window.FindName("StatusDot")
$StatusText   = $window.FindName("StatusText")
$NameText     = $window.FindName("NameText")
$PinText      = $window.FindName("PinText")
$RelayText    = $window.FindName("RelayText")
$TunnelPanel  = $window.FindName("TunnelPanel")
$TunnelText   = $window.FindName("TunnelText")
$StatRelay    = $window.FindName("StatRelay")
$StatTunnel   = $window.FindName("StatTunnel")
$StatCapture  = $window.FindName("StatCapture")
$StatUptime   = $window.FindName("StatUptime")

$script:DashUrl = ""

# Pre-built status colors (Colors.FromRgb is unreliable in Windows
# PowerShell 5.1, so go through ColorConverter instead).
$script:BrushOnline  = New-Object System.Windows.Media.SolidColorBrush -ArgumentList ([System.Windows.Media.ColorConverter]::ConvertFromString("#23A55A"))
$script:BrushOffline = New-Object System.Windows.Media.SolidColorBrush -ArgumentList ([System.Windows.Media.ColorConverter]::ConvertFromString("#9AA4B0"))

function Format-Uptime([int]$sec) {
  if ($sec -ge 3600) { return ("{0}h {1}m" -f [math]::Floor($sec / 3600), [math]::Floor(($sec % 3600) / 60)) }
  if ($sec -ge 60)   { return ("{0}m {1}s" -f [math]::Floor($sec / 60), ($sec % 60)) }
  return "$sec s"
}

function Update-Screen {
  try {
    $d = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/host-status" -TimeoutSec 2
  } catch {
    $StatusDot.Fill = $script:BrushOffline
    $StatusText.Text = "agent not reachable"
    return
  }

  if ($d.relayConnected) {
    $StatusDot.Fill = $script:BrushOnline
    $StatusText.Text = "online in the dashboard"
  } else {
    $StatusDot.Fill = $script:BrushOffline
    $StatusText.Text = "offline (relay not connected)"
  }

  $NameText.Text = $d.deviceName
  $PinText.Text  = $d.pin

  $script:DashUrl = ""
  if ($d.relayUrl) {
    try {
      $script:DashUrl = ([Uri]$d.relayUrl).AbsoluteUri -replace "/ws$", ""
      $RelayText.Text = $script:DashUrl
    } catch { $RelayText.Text = $d.relayUrl }
  } else {
    $RelayText.Text = "(relay disabled in config.json)"
  }

  if ($d.tunnelUrl) {
    $TunnelPanel.Visibility = "Visible"
    $TunnelText.Text = $d.tunnelUrl
  } else {
    $TunnelPanel.Visibility = "Collapsed"
  }

  $StatRelay.Text   = if ($d.relayConnected) { "Online" } else { "Offline" }
  $StatTunnel.Text  = if ($d.tunnelUrl) { "Up" } else { "Off" }
  $StatCapture.Text = if ($d.captureWanted) { "Yes" } else { "Idle" }
  $StatUptime.Text  = Format-Uptime ([int]$d.uptimeSec)
}

$window.FindName("CopyPinBtn").Add_Click({
  try { [System.Windows.Clipboard]::SetText($PinText.Text.Trim()) } catch {}
})
$window.FindName("CopyRelayBtn").Add_Click({
  try { [System.Windows.Clipboard]::SetText($script:DashUrl) } catch {}
})
$window.FindName("CopyTunnelBtn").Add_Click({
  try { [System.Windows.Clipboard]::SetText($TunnelText.Text.Trim()) } catch {}
})
$window.FindName("OpenDashBtn").Add_Click({
  if ($script:DashUrl) { Start-Process $script:DashUrl }
})
$window.FindName("WatchBtn").Add_Click({
  Start-Process "http://localhost:$Port/"
})
$window.FindName("StopBtn").Add_Click({
  $answer = [System.Windows.MessageBox]::Show(
    "Stop the agent on this PC? Anyone watching will be disconnected.",
    "ClankerDesk",
    [System.Windows.MessageBoxButton]::YesNo,
    [System.Windows.MessageBoxImage]::Warning)
  if ($answer -ne [System.Windows.MessageBoxResult]::Yes) { return }
  try {
    Invoke-RestMethod -Uri "http://127.0.0.1:$Port/host-stop" -Method Post -TimeoutSec 4 | Out-Null
    $window.Close()
  } catch {
    [System.Windows.MessageBox]::Show("Could not reach the agent: " + $_.Exception.Message, "ClankerDesk") | Out-Null
  }
})

$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromSeconds(2)
$timer.Add_Tick({ Update-Screen })
$timer.Start()
Update-Screen

$null = $window.ShowDialog()
$timer.Stop()
