"""공식 SHA256으로 고정한 PyYAML의 SafeLoader. 별칭·중복 키는 수락하지 않는다."""
import hashlib
from pathlib import Path
import sys

WHEEL = 'pyyaml-6.0.3-cp312-cp312-manylinux2014_aarch64.manylinux_2_17_aarch64.manylinux_2_28_aarch64.whl'
SHA256 = '9149cad251584d5fb4981be1ecde53a1ca46c891a79788c0df828d2f166bda28'
path = Path(__file__).with_name('vendor') / WHEEL
if hashlib.sha256(path.read_bytes()).hexdigest() != SHA256:
    raise RuntimeError('pinned_yaml_dependency_mismatch')
# zipimport는 wheel의 순수 Python SafeLoader를 사용한다. 호스트 ABI·외부 site-packages에 의존하지 않는다.
sys.path.insert(0, str(path))
import yaml
if yaml.__version__ != '6.0.3' or not yaml.__file__.startswith(str(path) + '/'):
    raise RuntimeError('pinned_yaml_loader_mismatch')


class StrictLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        result = {}
        for key_node, value_node in node.value:
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str) or key in result:
                raise ValueError('duplicate_or_nonstring_yaml_key')
            result[key] = self.construct_object(value_node, deep=deep)
        return result


def parse(value):
    if not isinstance(value, str) or len(value.encode()) > 262144:
        raise ValueError('yaml_input_invalid')
    if any(isinstance(token, (yaml.tokens.AnchorToken, yaml.tokens.AliasToken)) for token in yaml.scan(value)):
        raise ValueError('yaml_alias_rejected')
    return yaml.load(value, Loader=StrictLoader)
