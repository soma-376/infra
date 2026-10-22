import java.io.InputStream;
import java.lang.reflect.Field;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Properties;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/** 앱·네트워크 없이 실제 JVM의 차단 목록 로드와 기존 truststore 보존을 확인한다. */
public class BlockedCertsFixture {
    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static Properties properties(Path path) throws Exception {
        Properties result = new Properties();
        try (InputStream stream = Files.newInputStream(path)) {
            result.load(stream);
        }
        return result;
    }

    public static void main(String[] args) throws Exception {
        boolean mounted = args[0].equals("mounted");
        Path security = Path.of(System.getProperty("java.home"), "lib", "security");
        Path blocked = security.resolve("blocked.certs");
        if (!blocked.equals(Path.of("/opt/java/openjdk/lib/security/blocked.certs"))) {
            throw new AssertionError("예상과 다른 java.home: " + security);
        }
        Properties expected = properties(Path.of("/verification/expected-blocked.certs"));
        Properties actualFile = properties(blocked);
        if (!"SHA-256".equals(expected.getProperty("Algorithm"))) {
            throw new AssertionError("차단 목록 알고리즘 불일치");
        }
        if (mounted) {
            if (!expected.equals(actualFile) || Files.isWritable(blocked)) {
                throw new AssertionError("마운트 내용 또는 읽기 전용 권한 불일치");
            }
            // 파일만 확인하지 않고, 클래스 초기화로 JVM이 실제 로드한 static 목록을 대조한다.
            Class<?> checker = Class.forName("sun.security.util.UntrustedCertificates");
            Field field = checker.getDeclaredField("props");
            field.setAccessible(true);
            if (!expected.equals(field.get(null))) {
                throw new AssertionError("JVM의 실제 차단 목록이 공식 원본과 다름");
            }
        } else if (!expected.entrySet().containsAll(actualFile.entrySet())) {
            throw new AssertionError("교체 파일에 없는 기존 이미지 차단 항목이 있음");
        }

        // 단일 파일 mount가 cacerts와 주변 security 파일을 가리거나 바꾸지 않았는지 대조한다.
        StringBuilder inventory = new StringBuilder();
        try (var paths = Files.walk(security)) {
            for (Path path : paths.filter(Files::isRegularFile).sorted().toList()) {
                if (!path.equals(blocked)) {
                    inventory.append(security.relativize(path)).append(' ')
                        .append(sha256(Files.readAllBytes(path))).append('\n');
                }
            }
        }
        TrustManagerFactory factory = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
        factory.init((KeyStore) null);
        int issuers = 0;
        for (var manager : factory.getTrustManagers()) {
            if (manager instanceof X509TrustManager x509) issuers += x509.getAcceptedIssuers().length;
        }
        if (issuers == 0) throw new AssertionError("기본 truststore를 읽지 못함");
        System.out.println("java_version=" + System.getProperty("java.runtime.version"));
        System.out.println("security_files_sha256=" + sha256(inventory.toString().getBytes(StandardCharsets.UTF_8)));
        System.out.println("default_trust_issuers=" + issuers);
        System.out.println("blocked_entries=" + (actualFile.size() - 1));
        System.out.println("blocked_sha256=" + sha256(Files.readAllBytes(blocked)));
        System.out.println("jvm_loaded_verified=" + mounted);
    }
}
